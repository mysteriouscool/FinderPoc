import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { BearingEstimator, sectorOf } from './bearing-estimator';
import {
  DEFAULT_TRACKER_CONFIG,
  PathLossModel,
  Point2,
  ProximityBand,
  ProximityCue,
  RadarSnapshot,
  RadioProfile,
  RFID_UHF_PROFILE,
  RssiObservation,
  SignalTrend,
  TrackerConfig,
  TrailPoint,
  UserPose,
} from './radar.models';
import {
  clamp,
  estimateDistance,
  median,
  offsetPoint,
  wrapAngle,
} from './radar-math';
import { ParticleFilter } from './particle-filter';

/**
 * レーダー追跡アルゴリズムのファサード（Angular v13 サービス）。
 *
 * 【このサービスが担当する計算】
 * 1. 自己位置・方位の追跡（歩数＋コンパスによる簡易デッドレコニング）
 * 2. RSSI履歴のウィンドウ管理・中央値フィルタ（反射スパイク除去）
 * 3. 鮮度(isFresh)管理とトレンド判定（warmer / colder / steady）
 * 4. 合成開口方位推定 (BearingEstimator) と 2D位置推定 (ParticleFilter) の統合
 * 5. ガイガーカウンター風の近接フィードバック指標（無信号＝無音、遠距離＝遅いクリック）
 * 6. すべての計算結果を1つの不変 `RadarSnapshot` として出力
 *
 * 【RFID対応のポイント】
 * - デフォルトは `RFID_UHF_PROFILE`。`configure(BLE_PROFILE)` でBLEにも切替可能。
 * - `observeFrom(obs, readerPosition)` を使えば、複数の固定RFIDリーダー（アンカー）からの
 *   読み取りをそのまま三辺測量のように融合でき、ローカル表示や方位セクターを汚さない。
 */

interface HistorySample {
  timestampSec: number;
  dbm: number;
  priority: number;
}

const MAX_TRAIL_POINTS = 2048;

@Injectable({
  providedIn: 'root',
})
export class RadarTrackerService {
  private profile: RadioProfile = {
    ...RFID_UHF_PROFILE,
    pathLoss: { ...RFID_UHF_PROFILE.pathLoss },
  };
  private config: TrackerConfig = { ...DEFAULT_TRACKER_CONFIG };

  private filter: ParticleFilter;
  private bearing: BearingEstimator;

  private pose: UserPose = { position: { x: 0, y: 0 }, headingRad: 0 };
  private trail: TrailPoint[] = [];
  private steps = 0;
  private distanceWalkedM = 0;

  private history: HistorySample[] = [];
  private lastPredictSec = 0;
  private remoteObservations = 0;

  private readonly snapshotSubject: BehaviorSubject<RadarSnapshot>;
  readonly snapshot$: Observable<RadarSnapshot>;

  constructor() {
    this.filter = this.createFilter();
    this.bearing = new BearingEstimator(
      this.config.bearingSectors,
      this.profile.defaultSigmaDb
    );
    this.snapshotSubject = new BehaviorSubject<RadarSnapshot>(
      this.getSnapshot(0)
    );
    this.snapshot$ = this.snapshotSubject.asObservable();
  }

  /** 無線プロファイル（RFID / BLE等）や設定を切り替えてリセットする */
  configure(
    profile: RadioProfile,
    config: Partial<TrackerConfig> = {}
  ): void {
    this.profile = {
      ...profile,
      pathLoss: { ...profile.pathLoss },
    };
    this.config = { ...DEFAULT_TRACKER_CONFIG, ...config };
    this.pose = { position: { x: 0, y: 0 }, headingRad: 0 };
    this.trail = [];
    this.steps = 0;
    this.distanceWalkedM = 0;
    this.history = [];
    this.lastPredictSec = 0;
    this.remoteObservations = 0;
    this.filter = this.createFilter();
    this.bearing = new BearingEstimator(
      this.config.bearingSectors,
      this.profile.defaultSigmaDb
    );
    this.snapshotSubject.next(this.getSnapshot(0));
  }

  /** キャリブレーション後のパスロスモデルを反映する */
  setPathLoss(model: PathLossModel): void {
    this.profile = {
      ...this.profile,
      pathLoss: {
        txPower1m: model.txPower1m,
        exponent: Math.max(model.exponent, 1.5),
      },
    };
  }

  getProfile(): RadioProfile {
    return this.profile;
  }

  getUserPose(): UserPose {
    return {
      position: { ...this.pose.position },
      headingRad: this.pose.headingRad,
    };
  }

  getTrail(): readonly TrailPoint[] {
    return this.trail;
  }

  getParticles(): readonly Point2[] {
    return this.filter.getParticles();
  }

  /** コンパスの向き（またはRFIDリーダーを向けた方位）を更新 [rad, 北=0 時計回り] */
  setHeading(headingRad: number, timestampSec: number): void {
    if (!Number.isFinite(headingRad)) {
      return;
    }
    this.pose = {
      position: this.pose.position,
      headingRad: wrapAngle(headingRad),
    };
    this.pushTrail(timestampSec);
  }

  /** 向いている方向へ1歩進める（デッドレコニング） */
  step(timestampSec: number, lengthM = this.config.strideLengthM): void {
    const stride = Math.max(lengthM, 0);
    this.pose = {
      position: offsetPoint(this.pose.position, this.pose.headingRad, stride),
      headingRad: this.pose.headingRad,
    };
    this.steps += 1;
    this.distanceWalkedM += stride;
    this.pushTrail(timestampSec);
  }

  /** 既知の座標へユーザー位置を補正する（屋内アンカーや実測座標リプレイ用） */
  resetUserPosition(position: Point2, timestampSec: number): void {
    this.pose = {
      position: { x: position.x, y: position.y },
      headingRad: this.pose.headingRad,
    };
    this.pushTrail(timestampSec);
  }

  /** 現在位置で受信したRSSI観測を投入する（異常値は false を返して無視） */
  observe(obs: RssiObservation): boolean {
    return this.observeFrom(obs, this.pose.position, true);
  }

  /**
   * 任意座標の観測者（2台目の固定RFIDリーダーや他端末）からのRSSI観測を投入する。
   * ローカルのRSSI表示や方位セクターを乱さず、パーティクルフィルタの位置推定だけを絞る。
   */
  observeFrom(
    obs: RssiObservation,
    observerPosition: Point2,
    isLocal = false
  ): boolean {
    if (!this.isPlausibleRssi(obs.dbm) || !Number.isFinite(obs.timestampSec)) {
      return false;
    }

    const dt = obs.timestampSec - this.lastPredictSec;
    if (dt > 0) {
      this.filter.predict(dt);
      this.lastPredictSec = obs.timestampSec;
    }

    const sigmaDb = obs.sigmaDb ?? this.profile.defaultSigmaDb;
    this.filter.updateRssi(
      obs.dbm,
      observerPosition,
      sigmaDb,
      this.profile.pathLoss
    );

    if (isLocal) {
      this.history.push({
        timestampSec: obs.timestampSec,
        dbm: obs.dbm,
        priority: obs.priority ?? 0,
      });
      this.bearing.observe(obs.dbm, this.pose.headingRad);
    } else {
      this.remoteObservations += 1;
    }

    this.pruneHistory(obs.timestampSec);
    this.snapshotSubject.next(this.getSnapshot(obs.timestampSec));
    return true;
  }

  /** 推定データのみリセット（ユーザーの現在位置は維持する） */
  reset(nowSec = 0): void {
    this.filter.reset(this.pose.position);
    this.bearing.clear();
    this.history = [];
    this.remoteObservations = 0;
    this.snapshotSubject.next(this.getSnapshot(nowSec));
  }

  /** 指定時刻 nowSec における最新スナップショットを生成して返す */
  getSnapshot(nowSec: number): RadarSnapshot {
    const live = this.medianOfBestPriority(this.config.liveWindowSec, nowSec);
    const newest =
      this.history.length > 0 ? this.history[this.history.length - 1] : null;
    const ageSec = newest ? Math.max(nowSec - newest.timestampSec, 0) : null;
    const isFresh = ageSec !== null && ageSec < this.profile.freshnessSec;

    const rssiDbm = live ? live.medianDbm : null;
    const crudeDistanceM =
      rssiDbm !== null ? estimateDistance(rssiDbm, this.profile.pathLoss) : null;

    return {
      timestampSec: nowSec,
      profileName: this.profile.name,
      rssiDbm,
      isFresh,
      ageSec,
      crudeDistanceM,
      proximityBand: rssiDbm !== null ? this.classifyProximity(rssiDbm) : null,
      trend: this.computeTrend(nowSec),
      proximityCue:
        isFresh && rssiDbm !== null ? this.computeProximityCue(rssiDbm) : null,
      fix: this.filter.getFix(this.pose.position),
      bearing: this.bearing.estimate(),
      sectorMeans: this.bearing.sectorMeans(),
      userPose: this.getUserPose(),
      steps: this.steps,
      distanceWalkedM: this.distanceWalkedM,
      headingCoverage: this.computeHeadingCoverage(),
      samplesInWindow: live ? live.count : 0,
      totalSamples: this.history.length,
      observations: this.filter.observations,
      remoteObservations: this.remoteObservations,
      diverged: this.filter.diverged,
    };
  }

  // ---- 内部計算ヘルパー ----

  private createFilter(): ParticleFilter {
    return new ParticleFilter(
      {
        particleCount: this.config.particleCount,
        initRadiusM: this.profile.initRadiusM,
      },
      this.pose.position,
      this.config.seed
    );
  }

  private isPlausibleRssi(dbm: number): boolean {
    return (
      Number.isFinite(dbm) &&
      dbm >= this.profile.minRssiDbm &&
      dbm <= this.profile.maxRssiDbm
    );
  }

  private pushTrail(timestampSec: number): void {
    if (this.trail.length >= MAX_TRAIL_POINTS) {
      this.trail.shift();
    }
    this.trail.push({
      position: { ...this.pose.position },
      headingRad: this.pose.headingRad,
      timestampSec,
    });
  }

  private pruneHistory(nowSec: number): void {
    let cut = 0;
    while (
      cut < this.history.length &&
      nowSec - this.history[cut].timestampSec > this.config.historySec
    ) {
      cut++;
    }
    if (cut > 0) {
      this.history.splice(0, cut);
    }
  }

  private windowSamples(windowSec: number, nowSec: number): HistorySample[] {
    const result: HistorySample[] = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      const s = this.history[i];
      if (nowSec - s.timestampSec > windowSec) {
        break;
      }
      result.push(s);
    }
    return result;
  }

  /**
   * ウィンドウ内で最も優先度が高い（priority最小）ソースだけを集めて中央値を返す。
   * これにより、頻度が高いだけの低品質ソースが高品質ソースを多数決で上書きするのを防ぐ。
   */
  private medianOfBestPriority(
    windowSec: number,
    nowSec: number
  ): { medianDbm: number; count: number } | null {
    const samples = this.windowSamples(windowSec, nowSec);
    if (samples.length === 0) {
      return null;
    }
    let bestPriority = Infinity;
    for (const s of samples) {
      if (s.priority < bestPriority) {
        bestPriority = s.priority;
      }
    }
    const values: number[] = [];
    for (const s of samples) {
      if (s.priority === bestPriority) {
        values.push(s.dbm);
      }
    }
    const med = median(values);
    return med !== null ? { medianDbm: med, count: values.length } : null;
  }

  /** 直近ウィンドウと過去ウィンドウの中央値差から接近／離反を判定 */
  private computeTrend(nowSec: number): SignalTrend {
    const recent = this.medianOfBestPriority(this.config.liveWindowSec, nowSec);
    if (!recent || recent.count < 2) {
      return 'unknown';
    }

    const olderValues: number[] = [];
    for (const s of this.windowSamples(this.config.trendWindowSec, nowSec)) {
      const age = nowSec - s.timestampSec;
      if (age > this.config.liveWindowSec) {
        olderValues.push(s.dbm);
      }
    }
    if (olderValues.length < 2) {
      return 'unknown';
    }

    const oldMed = median(olderValues);
    if (oldMed === null) {
      return 'unknown';
    }

    const delta = recent.medianDbm - oldMed;
    if (delta > this.config.trendThresholdDb) {
      return 'warmer';
    }
    if (delta < -this.config.trendThresholdDb) {
      return 'colder';
    }
    return 'steady';
  }

  /** プロファイルの nearDbm..farDbm で正規化した近接区分（RFID/BLE両対応） */
  private classifyProximity(dbm: number): ProximityBand {
    const intensity = this.normaliseIntensity(dbm);
    if (intensity >= 0.85) {
      return 'arms-reach';
    }
    if (intensity >= 0.65) {
      return 'near';
    }
    if (intensity >= 0.4) {
      return 'mid';
    }
    if (intensity >= 0.15) {
      return 'far';
    }
    return 'very-far';
  }

  /**
   * 幾何補間でクリック間隔・音程を算出（人間の聴覚は対数知覚のため線形補間しない）。
   * 無音になるのは「無信号(isFresh=false)」のときだけ。遠くても遅く鳴らし続ける。
   */
  private computeProximityCue(dbm: number): ProximityCue {
    const t = this.normaliseIntensity(dbm);
    const minIntervalMs = 70;
    const maxIntervalMs = 1400;
    const minPitchHz = 440;
    const maxPitchHz = 1320;

    const intervalMs = Math.round(
      maxIntervalMs * Math.pow(minIntervalMs / maxIntervalMs, t)
    );
    const pitchHz = Math.round(
      minPitchHz * Math.pow(maxPitchHz / minPitchHz, t)
    );

    return { intervalMs, pitchHz, intensity: t };
  }

  private normaliseIntensity(dbm: number): number {
    const span = Math.max(this.profile.nearDbm - this.profile.farDbm, 1);
    return clamp((dbm - this.profile.farDbm) / span, 0, 1);
  }

  private computeHeadingCoverage(): number {
    const sectors = this.config.bearingSectors;
    if (sectors <= 0 || this.trail.length === 0) {
      return 0;
    }
    const seen = new Array<boolean>(sectors).fill(false);
    for (const pt of this.trail) {
      seen[sectorOf(pt.headingRad, sectors)] = true;
    }
    let count = 0;
    for (const v of seen) {
      if (v) {
        count++;
      }
    }
    return count / sectors;
  }
}
