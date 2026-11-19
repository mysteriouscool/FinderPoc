/**
 * レーダー計算コアのデータ型と無線プロファイル定義。
 *
 * 【RFID対応のための設計方針（BLE専用機能との分離）】
 * 元のRust実装(superfind-core)にあった以下のBLE固有前提は排除しています：
 *   - GATT接続RSSI / BLEアドバタイズ / ClassicPoll の固定列挙型
 *     → RFIDにはGATT接続やアドバタイズがないため、観測値は単純な
 *       `dbm + timestampSec + (任意)sigmaDb + (任意)priority` に統一。
 *   - BLE HCI固有の欠損値(-127 dBm)や 2.4GHz前提の定数(-59 dBm, n=2.8)
 *     → `RadioProfile` で RFID(UHF 920MHz) / BLE を切替可能に。
 *   - BLE専用の MACアドレス解析・DULTストーカー検知・UWB AoA・Channel Sounding・気圧計
 *     → レーダー計算の本質ではないため削除。
 */

/** ローカル平面座標（単位: メートル）。+x = 東, +y = 北 */
export interface Point2 {
  x: number;
  y: number;
}

/** ユーザー（またはハンディリーダー）の姿勢 */
export interface UserPose {
  position: Point2;
  /** コンパス方位（ラジアン、北=0、時計回り正） */
  headingRad: number;
}

/** 移動軌跡の1点 */
export interface TrailPoint {
  position: Point2;
  headingRad: number;
  timestampSec: number;
}

/** 対数距離パスロスモデルのパラメータ: RSSI(d) = txPower1m - 10 * exponent * log10(d) */
export interface PathLossModel {
  /** 1m地点での期待RSSI [dBm] */
  txPower1m: number;
  /** パスロス指数 n（自由空間=2.0、屋内BLE=2.8前後、パッシブUHF RFID往復減衰=3.5〜4.0前後） */
  exponent: number;
}

/**
 * 無線方式ごとの物理パラメータ定義。
 * RFIDとBLEで異なる電波減衰・有効RSSI範囲・読み取り距離をここで吸収する。
 */
export interface RadioProfile {
  name: string;
  pathLoss: PathLossModel;
  /** RSSI観測ノイズの標準偏差 [dB]（尤度計算と方位の有意性判定に使用） */
  defaultSigmaDb: number;
  /** 物理的に妥当とみなすRSSI下限 [dBm]（これ以下は異常値として除外） */
  minRssiDbm: number;
  /** 物理的に妥当とみなすRSSI上限 [dBm]（これ以上は異常値として除外） */
  maxRssiDbm: number;
  /** 至近距離（強度1.0）とみなすRSSI [dBm] */
  nearDbm: number;
  /** 遠距離（強度0.0）とみなすRSSI [dBm] */
  farDbm: number;
  /** 最後の受信から何秒以内で「信号あり(fresh)」とみなすか */
  freshnessSec: number;
  /** パーティクルフィルタ初期散布半径 [m] */
  initRadiusM: number;
}

/**
 * パッシブ UHF RFID (920MHz帯) 向けプリセット。
 *
 * 注意点:
 * - パッシブRFIDは「リーダー→タグ→リーダー」の往復減衰（バックスキャッタ）のため、
 *   距離に対するdB減衰がBLEより急（exponent ≒ 3.6）。
 * - 実用読み取り距離は数m〜10m程度なので初期半径を小さめに設定。
 * - ハンディリーダーは指向性アンテナを持つことが多く、セクター別方位推定(Synthetic Aperture)と
 *   非常に相性が良い（人体遮蔽に頼らなくても方位差が出やすい）。
 * - タグはビーム内に入った時だけ間欠的に読まれるため、freshnessSecは短めに管理。
 */
export const RFID_UHF_PROFILE: RadioProfile = {
  name: 'RFID (UHF 920MHz)',
  pathLoss: {
    txPower1m: -50.0,
    exponent: 3.6,
  },
  defaultSigmaDb: 5.0,
  minRssiDbm: -95.0,
  maxRssiDbm: -15.0,
  nearDbm: -35.0,
  farDbm: -80.0,
  freshnessSec: 5.0,
  initRadiusM: 15.0,
};

/**
 * BLE (2.4GHz) 向けプリセット（元の superfind-core 相当）。
 *
 * 注意点:
 * - スマホ等の無指向性アンテナでは単体で方位が分からないため、
 *   ユーザーがその場で回る「人体遮蔽(5〜15dB減衰)」でセクター差を作る。
 * - BLE HCIの欠損値 -127 dBm を除外するため minRssiDbm = -126.5。
 */
export const BLE_PROFILE: RadioProfile = {
  name: 'BLE (2.4GHz)',
  pathLoss: {
    txPower1m: -59.0,
    exponent: 2.8,
  },
  defaultSigmaDb: 6.0,
  minRssiDbm: -126.5,
  maxRssiDbm: -0.5,
  nearDbm: -45.0,
  farDbm: -95.0,
  freshnessSec: 10.0,
  initRadiusM: 60.0,
};

/**
 * 1回分のRSSI観測データ（RFID/BLE共通）。
 * BLE専用の接続/アドバタイズ区別は持たず、ノイズ幅(sigmaDb)と優先度(priority)で汎用化。
 */
export interface RssiObservation {
  /** 受信信号強度 [dBm] */
  dbm: number;
  /** セッション開始からの経過秒数 [s] */
  timestampSec: number;
  /** この観測のノイズ標準偏差 [dB]（省略時は RadioProfile.defaultSigmaDb） */
  sigmaDb?: number;
  /**
   * ソース優先度（小さいほど高信頼、省略時は 0）。
   * 例: BLEで「接続RSSI(priority=0)」と「アドバタイズ(priority=1)」が混在する場合、
   * 同一ウィンドウ内では高信頼ソースのみで中央値を計算する。RFID単体なら省略でOK。
   */
  priority?: number;
}

/** 95%信頼楕円（2x2共分散行列の固有値分解から算出） */
export interface ConfidenceEllipse {
  centre: Point2;
  /** 長半径 [m] */
  semiMajorM: number;
  /** 短半径 [m] */
  semiMinorM: number;
  /** 長軸の方位（ラジアン、北=0、時計回り正） */
  orientationRad: number;
}

/** 合成開口（方位セクター別RSSI）による方位推定結果 */
export interface BearingEstimate {
  /** 推定方位（ラジアン、北=0、時計回り正） */
  bearingRad: number;
  /** 角度の標準偏差（1σ）[rad]（最小でも半セクター幅） */
  sigmaRad: number;
  /** 信頼度 0..1（coverage × concentration × significance の積。0.3未満は未確定扱い推奨） */
  confidence: number;
  /** 全セクターのうち観測済みセクターの割合 0..1 */
  coverage: number;
  /** ピークと平均の差 [dB] */
  contrastDb: number;
  /** 累計サンプル数 */
  samples: number;
}

/** パーティクルフィルタによる2D位置推定結果 */
export interface PositionFix {
  /** 重み付き平均位置 [m] */
  position: Point2;
  /** 95%信頼楕円（点ではなく必ずこの広がりで不確実性を扱う） */
  ellipse: ConfidenceEllipse;
  /** ユーザーから推定位置までの距離 [m] */
  distanceM: number;
  /** ユーザーから推定位置への方位 [rad] */
  bearingRad: number;
  /** パーティクル方位の円標準偏差 [rad]（1点観測のリング状態では大きい） */
  bearingSigmaRad: number;
  /** 距離に対する楕円の小ささから求める信頼度 0..1 */
  confidence: number;
  /** 有効サンプルサイズ比 (ESS / N) 0..1 */
  effectiveFraction: number;
  /** 反映済み観測数 */
  observations: number;
}

/** 近接度の粗い区分 */
export type ProximityBand = 'arms-reach' | 'near' | 'mid' | 'far' | 'very-far';

/** 信号強度の変化トレンド */
export type SignalTrend = 'warmer' | 'colder' | 'steady' | 'unknown';

/** 音・振動フィードバック用のガイガーカウンター指標（無信号時は null） */
export interface ProximityCue {
  /** クリック間隔 [ms]（近いほど短い、下限60msでリズムを維持） */
  intervalMs: number;
  /** 音程 [Hz]（近いほど高い） */
  pitchHz: number;
  /** 正規化強度 0..1 */
  intensity: number;
}

/** トラッカーの設定パラメータ */
export interface TrackerConfig {
  /** 方位セクター分割数（デフォルト16 = 22.5度刻み） */
  bearingSectors: number;
  /** パーティクル数（ブラウザ向けにデフォルト512、精度重視なら1024〜2048） */
  particleCount: number;
  /** 1歩の歩幅 [m] */
  strideLengthM: number;
  /** 表示RSSI中央値を取る直近ウィンドウ幅 [s] */
  liveWindowSec: number;
  /** トレンド比較用の過去ウィンドウ幅 [s] */
  trendWindowSec: number;
  /** warmer/colder 判定のしきい値 [dB] */
  trendThresholdDb: number;
  /** 履歴保持時間 [s] */
  historySec: number;
  /** 乱数シード（テスト再現用） */
  seed: number;
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  bearingSectors: 16,
  particleCount: 512,
  strideLengthM: 0.72,
  liveWindowSec: 4.0,
  trendWindowSec: 12.0,
  trendThresholdDb: 3.0,
  historySec: 300.0,
  seed: 0x5f1d9e2b,
};

/**
 * UIや呼び出し元へ渡す不変スナップショット。
 * すべての表示値（RSSI・距離・方位・位置・トレンド）を同一時刻の1オブジェクトに集約する。
 */
export interface RadarSnapshot {
  timestampSec: number;
  profileName: string;
  /** 直近ウィンドウの中央値RSSI [dBm]（外れ値に強い） */
  rssiDbm: number | null;
  /** 信号が鮮度内か。false のときは「無信号」扱い（遠距離と混同しない） */
  isFresh: boolean;
  /** 最新観測からの経過時間 [s] */
  ageSec: number | null;
  /** 単一RSSIからの粗い距離推定 [m]（表示参考用。フィルタ入力には使わない） */
  crudeDistanceM: number | null;
  proximityBand: ProximityBand | null;
  trend: SignalTrend;
  /** ガイガーカウンター風の近接フィードバック（無信号時のみ null） */
  proximityCue: ProximityCue | null;
  /** パーティクルフィルタによる位置推定（観測前は null） */
  fix: PositionFix | null;
  /** 合成開口による方位推定（2セクター未満は null） */
  bearing: BearingEstimate | null;
  /** 各セクターの平均RSSI（未スキャン方位は null → レーダーの未探索ギャップになる） */
  sectorMeans: (number | null)[];
  userPose: UserPose;
  steps: number;
  distanceWalkedM: number;
  /** 探索済み方位の割合 0..1 */
  headingCoverage: number;
  samplesInWindow: number;
  totalSamples: number;
  observations: number;
  /** 他リーダー/他端末から届いた観測数 */
  remoteObservations: number;
  /** モデルと観測が著しく矛盾して発散したか（true なら reset 推奨） */
  diverged: boolean;
}
