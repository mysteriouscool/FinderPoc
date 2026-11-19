import { ConfidenceEllipse, PathLossModel, Point2 } from './radar.models';

/**
 * レーダー計算の基礎数学モジュール。
 *
 * 【計算すべき重要ポイント】
 * 1. 角度の正規化（北=0, 時計回り, -π..π と 0..2π のラップ処理）
 * 2. 対数距離パスロスモデル（RSSIの誤差は距離空間ではなく「dB空間」でガウス分布する）
 * 3. 2x2共分散行列の固有値分解による 95%信頼楕円（χ²(2, 0.95) = 5.991）
 * 4. 最小二乗法によるパスロス校正（RFIDタグ/リーダーごとの実測キャリブレーション用）
 * 5. 決定的な疑似乱数（同じシードでテストを完全再現するため）
 */

export const TWO_PI = Math.PI * 2;
export const MIN_DISTANCE_M = 0.25;
const LN_TWO_PI = Math.log(TWO_PI);
/** 自由度2のカイ二乗分布 95%点 */
const CHI2_95_DOF2 = 5.99146454710798;

// ============================================================
// 1. 角度・2D平面幾何（ENU座標: +x=東, +y=北, 方位=北から時計回り）
// ============================================================

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** 角度を (-π, π] に正規化する */
export function wrapAngle(rad: number): number {
  let a = rad % TWO_PI;
  if (a > Math.PI) {
    a -= TWO_PI;
  } else if (a <= -Math.PI) {
    a += TWO_PI;
  }
  return a;
}

/** 角度を [0, 2π) に正規化する（セクター番号計算・コンパス表示用） */
export function wrapPositive(rad: number): number {
  const a = rad % TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}

/** from から to への最短回転角 (-π, π] */
export function angleDiff(fromRad: number, toRad: number): number {
  return wrapAngle(toRad - fromRad);
}

export function distanceBetween(a: Point2, b: Point2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** a から b へのコンパス方位（北=0, 時計回り正） */
export function bearingBetween(from: Point2, to: Point2): number {
  return wrapAngle(Math.atan2(to.x - from.x, to.y - from.y));
}

/** origin からコンパス方位 bearingRad へ distanceM 進んだ点 */
export function offsetPoint(
  origin: Point2,
  bearingRad: number,
  distanceM: number
): Point2 {
  return {
    x: origin.x + distanceM * Math.sin(bearingRad),
    y: origin.y + distanceM * Math.cos(bearingRad),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ============================================================
// 2. 対数距離パスロスモデル & キャリブレーション
// ============================================================

/** 距離 distanceM [m] のときに期待される RSSI [dBm] */
export function expectedRssi(distanceM: number, model: PathLossModel): number {
  const d = Math.max(distanceM, MIN_DISTANCE_M);
  return model.txPower1m - 10 * model.exponent * Math.log10(d);
}

/**
 * 単一RSSIからの粗い距離推定 [m]。
 * ※ 表示や初期粒子生成には使えるが、遮蔽物で数倍ズレるためフィルタの尤度計算には使わない。
 */
export function estimateDistance(rssiDbm: number, model: PathLossModel): number {
  const exponent = Math.max(model.exponent, 1.5);
  const power = (model.txPower1m - rssiDbm) / (10 * exponent);
  return Math.max(Math.pow(10, power), MIN_DISTANCE_M);
}

/**
 * 距離 candidateDistanceM にタグがあると仮定したときの、観測RSSIの対数尤度。
 *
 * 【重要】RSSIをメートルに変換してからガウス誤差を当てるのは誤り。
 * 電波のシャドーイング誤差は「dB空間」で正規分布するため、必ずdB空間で評価する。
 */
export function rssiLogLikelihood(
  observedDbm: number,
  candidateDistanceM: number,
  sigmaDb: number,
  model: PathLossModel
): number {
  const sigma = Math.max(sigmaDb, 0.5);
  const residual = (observedDbm - expectedRssi(candidateDistanceM, model)) / sigma;
  return -0.5 * residual * residual - Math.log(sigma) - 0.5 * LN_TWO_PI;
}

/**
 * (距離[m], 実測RSSI[dBm]) の組から最小二乗法で PathLossModel を推定する。
 * RFIDタグやリーダー環境に合わせて 1m, 2m, 4m 等で実測校正する際に利用。
 */
export function fitPathLoss(
  samples: ReadonlyArray<{ distanceM: number; rssiDbm: number }>
): PathLossModel | null {
  const usable: Array<{ x: number; y: number }> = [];
  for (const s of samples) {
    if (
      Number.isFinite(s.distanceM) &&
      Number.isFinite(s.rssiDbm) &&
      s.distanceM >= MIN_DISTANCE_M
    ) {
      usable.push({ x: Math.log10(s.distanceM), y: s.rssiDbm });
    }
  }
  if (usable.length < 2) {
    return null;
  }

  let meanX = 0;
  let meanY = 0;
  for (const p of usable) {
    meanX += p.x;
    meanY += p.y;
  }
  meanX /= usable.length;
  meanY /= usable.length;

  let sxx = 0;
  let sxy = 0;
  for (const p of usable) {
    const dx = p.x - meanX;
    sxx += dx * dx;
    sxy += dx * (p.y - meanY);
  }
  // 同じ距離のサンプルしかない場合は傾きが求まらない
  if (sxx < 1e-9) {
    return null;
  }

  const slope = sxy / sxx;
  return {
    txPower1m: meanY - slope * meanX,
    exponent: Math.max(-slope / 10, 1.5),
  };
}

/** キャリブレーション結果のRMS残差 [dB]（屋内良好なら3〜5dB、8dB超なら棄却推奨） */
export function pathLossResidualRms(
  model: PathLossModel,
  samples: ReadonlyArray<{ distanceM: number; rssiDbm: number }>
): number | null {
  let sumSq = 0;
  let count = 0;
  for (const s of samples) {
    if (
      Number.isFinite(s.distanceM) &&
      Number.isFinite(s.rssiDbm) &&
      s.distanceM >= MIN_DISTANCE_M
    ) {
      const diff = s.rssiDbm - expectedRssi(s.distanceM, model);
      sumSq += diff * diff;
      count++;
    }
  }
  return count > 0 ? Math.sqrt(sumSq / count) : null;
}

/** 校正結果が物理的にあり得る範囲かチェック（異常な反射環境での過学習を防ぐ） */
export function isPathLossPlausible(model: PathLossModel): boolean {
  return (
    Number.isFinite(model.txPower1m) &&
    Number.isFinite(model.exponent) &&
    model.txPower1m >= -100 &&
    model.txPower1m <= -15 &&
    model.exponent >= 1.5 &&
    model.exponent <= 6.0
  );
}

// ============================================================
// 3. 2x2共分散行列 → 95%信頼楕円
// ============================================================

/** 2x2対称共分散行列から閉形式で固有値分解し、95%信頼楕円を返す */
export function covarianceToEllipse(
  centre: Point2,
  xx: number,
  xy: number,
  yy: number
): ConfidenceEllipse {
  const trace = xx + yy;
  const det = xx * yy - xy * xy;
  const disc = Math.sqrt(Math.max((trace * trace) / 4 - det, 0));
  const l1 = Math.max(trace / 2 + disc, 0);
  const l2 = Math.max(trace / 2 - disc, 0);

  let ex: number;
  let ey: number;
  if (Math.abs(xy) > 1e-12) {
    ex = xy;
    ey = l1 - xx;
  } else if (xx >= yy) {
    ex = 1;
    ey = 0;
  } else {
    ex = 0;
    ey = 1;
  }

  return {
    centre,
    semiMajorM: Math.sqrt(CHI2_95_DOF2 * l1),
    semiMinorM: Math.sqrt(CHI2_95_DOF2 * l2),
    orientationRad: wrapAngle(Math.atan2(ex, ey)),
  };
}

// ============================================================
// 4. 中央値計算 & 決定的PRNG（パーティクルフィルタ用）
// ============================================================

/** 配列の中央値（元配列は変更しない） */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * シンプルなシード付き疑似乱数生成器（Mulberry32 + Box-Muller法）。
 * テスト再現性のために Math.random() の代わりに使用する。
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) の一様乱数 */
  uniform(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 正規分布 N(mean, sigma^2) */
  normal(mean = 0, sigma = 1): number {
    let u = 0;
    let v = 0;
    while (u <= 1e-12) {
      u = this.uniform();
    }
    v = this.uniform();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
    return mean + sigma * z;
  }
}
