import { PathLossModel, Point2, PositionFix } from './radar.models';
import {
  bearingBetween,
  clamp,
  covarianceToEllipse,
  distanceBetween,
  estimateDistance,
  expectedRssi,
  offsetPoint,
  rssiLogLikelihood,
  SeededRng,
  TWO_PI,
  wrapAngle,
} from './radar-math';

/**
 * 2Dパーティクルフィルタ（タグ／デバイスの平面位置推定）。
 *
 * 【なぜカルマンフィルタではなくパーティクルフィルタなのか】
 * 1地点からのRSSI観測が示す存在範囲は「点」ではなく「円環（リング状）」になり、
 * 2地点からの観測では「2つの交点（双峰分布）」になる。
 * 通常のカルマンフィルタは単峰ガウス分布を仮定するため、2交点の真ん中の「何もない空間」を
 * 高信頼に指してしまう。パーティクルフィルタならリングや双峰分布をそのまま表現でき、
 * ユーザーがL字（ドッグレッグ）に歩くか3台目のリーダー観測が入ると自然に1点へ収束する。
 *
 * 【計算上の重要ポイント】
 * 1. 重みは対数空間(logWeights)で加算し、log-sum-exp で正規化する（アンダーフロー防止）
 * 2. 初回観測だけは一様円盤を重み付けせず、観測に整合する円環上に直接粒子を散布する
 * 3. 有効サンプルサイズ(ESS)が低下したら Systematic Resampling + 微小ジッター(roughening)
 * 4. ESSが極端に低下したら最新観測から粒子を一部再注入(rejuvenation)
 * 5. 全粒子で説明できない観測が続いたら diverged=true を立てて嘘の座標を出さない
 */

export interface ParticleFilterConfig {
  particleCount: number;
  initRadiusM: number;
  /** 1秒あたりのランダムウォーク標準偏差 [m/s]（タグは静止前提、自己位置誤差吸収用） */
  processNoiseMPerSec: number;
  /** リサンプリング後の粒子拡散ジッター [m]（粒子退化防止） */
  rougheningM: number;
  /** ESS/N がこれを下回ったらリサンプリング */
  resampleThreshold: number;
  /** ESS/N がこれを下回ったら粒子の一部を再注入 */
  rejuvenateThreshold: number;
  /** 再注入で置き換える粒子割合 */
  rejuvenateFraction: number;
  /** 最良粒子でもこの σ 倍以上ズレていたら「不適合観測」とみなす */
  badFitSigmas: number;
  /** 連続不適合回数で発散(diverged)判定 */
  badFitsBeforeDiverged: number;
}

export const DEFAULT_FILTER_CONFIG: ParticleFilterConfig = {
  particleCount: 512,
  initRadiusM: 15.0,
  processNoiseMPerSec: 0.05,
  rougheningM: 0.15,
  resampleThreshold: 0.5,
  rejuvenateThreshold: 0.05,
  rejuvenateFraction: 0.3,
  badFitSigmas: 6.0,
  badFitsBeforeDiverged: 8,
};

export class ParticleFilter {
  private readonly config: ParticleFilterConfig;
  private particles: Point2[];
  private logWeights: number[];
  private rng: SeededRng;
  private observationCount = 0;
  private isDiverged = false;
  private consecutiveBadFits = 0;

  constructor(
    config: Partial<ParticleFilterConfig> = {},
    centre: Point2 = { x: 0, y: 0 },
    seed = 1
  ) {
    this.config = { ...DEFAULT_FILTER_CONFIG, ...config };
    this.rng = new SeededRng(seed);
    const n = Math.max(Math.floor(this.config.particleCount), 1);
    this.particles = Array.from({ length: n }, () =>
      this.sampleUniformDisc(centre, this.config.initRadiusM)
    );
    this.logWeights = new Array<number>(n).fill(0);
  }

  get observations(): number {
    return this.observationCount;
  }

  get diverged(): boolean {
    return this.isDiverged;
  }

  /** デバッグやヒートマップ描画用の粒子座標配列 */
  getParticles(): readonly Point2[] {
    return this.particles;
  }

  /** 全証拠を破棄し、centre 中心の一様円盤からやり直す */
  reset(centre: Point2): void {
    for (let i = 0; i < this.particles.length; i++) {
      this.particles[i] = this.sampleUniformDisc(centre, this.config.initRadiusM);
      this.logWeights[i] = 0;
    }
    this.observationCount = 0;
    this.isDiverged = false;
    this.consecutiveBadFits = 0;
  }

  /** 経過時間 dtSec に応じて粒子をわずかに拡散（予測ステップ） */
  predict(dtSec: number): void {
    if (dtSec <= 0) {
      return;
    }
    const sigma = this.config.processNoiseMPerSec * dtSec;
    if (sigma <= 0) {
      return;
    }
    for (const p of this.particles) {
      p.x += this.rng.normal(0, sigma);
      p.y += this.rng.normal(0, sigma);
    }
  }

  /**
   * RSSI観測を1件取り込む（更新ステップ）。
   * RFIDでもBLEでも同じ数式で動作する。
   */
  updateRssi(
    dbm: number,
    observer: Point2,
    sigmaDb: number,
    model: PathLossModel
  ): void {
    const sigma = Math.max(sigmaDb, 0.5);

    // 初回観測は円環事後分布から直接サンプリングして初期化
    if (this.observationCount === 0) {
      for (let i = 0; i < this.particles.length; i++) {
        this.particles[i] = this.proposeFromRssi(dbm, observer, sigma, model);
        this.logWeights[i] = 0;
      }
      this.observationCount = 1;
      return;
    }

    let bestZ = Infinity;
    for (let i = 0; i < this.particles.length; i++) {
      const d = distanceBetween(observer, this.particles[i]);
      this.logWeights[i] += rssiLogLikelihood(dbm, d, sigma, model);
      const z = Math.abs((dbm - expectedRssi(d, model)) / sigma);
      if (z < bestZ) {
        bestZ = z;
      }
    }

    this.observationCount += 1;
    this.recordFitQuality(bestZ);
    this.maybeResample(() => this.proposeFromRssi(dbm, observer, sigma, model));
  }

  /**
   * 距離の直接測定値を取り込む（任意の拡張用: 測距センサーがある場合のみ利用）。
   * RFID単体運用では呼ばずに updateRssi のみで完結する。
   */
  updateRange(metres: number, observer: Point2, sigmaM: number): void {
    if (!Number.isFinite(metres) || metres < 0) {
      return;
    }
    const sigma = Math.max(sigmaM, 0.01);

    if (this.observationCount === 0) {
      for (let i = 0; i < this.particles.length; i++) {
        this.particles[i] = this.proposeFromRange(metres, observer, sigma);
        this.logWeights[i] = 0;
      }
      this.observationCount = 1;
      return;
    }

    let bestZ = Infinity;
    for (let i = 0; i < this.particles.length; i++) {
      const residual = (distanceBetween(observer, this.particles[i]) - metres) / sigma;
      this.logWeights[i] += -0.5 * residual * residual;
      const absZ = Math.abs(residual);
      if (absZ < bestZ) {
        bestZ = absZ;
      }
    }

    this.observationCount += 1;
    this.recordFitQuality(bestZ);
    this.maybeResample(() => this.proposeFromRange(metres, observer, sigma));
  }

  /**
   * 現在の推定位置・95%信頼楕円・信頼度を返す。
   * 1回も観測がない場合は事前分布を誤魔化して返さず null を返す。
   */
  getFix(userPosition: Point2): PositionFix | null {
    if (this.observationCount === 0) {
      return null;
    }
    const weights = this.normalisedWeights();
    if (!weights) {
      return null;
    }

    // 1) 重み付き平均位置
    let meanX = 0;
    let meanY = 0;
    for (let i = 0; i < this.particles.length; i++) {
      meanX += this.particles[i].x * weights[i];
      meanY += this.particles[i].y * weights[i];
    }
    const mean: Point2 = { x: meanX, y: meanY };

    // 2) 重み付き 2x2 共分散行列 → 95%信頼楕円
    let xx = 0;
    let xy = 0;
    let yy = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const dx = this.particles[i].x - mean.x;
      const dy = this.particles[i].y - mean.y;
      const w = weights[i];
      xx += w * dx * dx;
      xy += w * dx * dy;
      yy += w * dy * dy;
    }
    const ellipse = covarianceToEllipse(mean, xx, xy, yy);

    // 3) 粒子方位の円統計（北をまたいでも破綻しない角度のばらつき）
    let sinSum = 0;
    let cosSum = 0;
    let angularWeight = 0;
    let sumSq = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const w = weights[i];
      sumSq += w * w;
      if (distanceBetween(userPosition, this.particles[i]) < 1e-9) {
        continue;
      }
      const b = bearingBetween(userPosition, this.particles[i]);
      sinSum += w * Math.sin(b);
      cosSum += w * Math.cos(b);
      angularWeight += w;
    }

    let bearingRad = 0;
    let bearingSigmaRad = Math.PI;
    if (angularWeight > 0) {
      const r = clamp(Math.hypot(sinSum, cosSum) / angularWeight, 1e-9, 1);
      bearingRad = wrapAngle(Math.atan2(sinSum, cosSum));
      bearingSigmaRad = Math.sqrt(-2 * Math.log(r));
    }

    const distanceM = distanceBetween(userPosition, mean);
    // 距離に対する楕円長半径の比から 0..1 の信頼度へ
    const relativeSpread = ellipse.semiMajorM / Math.max(distanceM, 1.0);
    const confidence = clamp(1 / (1 + relativeSpread), 0, 1);
    const effectiveFraction =
      sumSq > 0 ? 1 / sumSq / this.particles.length : 0;

    return {
      position: mean,
      ellipse,
      distanceM,
      bearingRad,
      bearingSigmaRad,
      confidence,
      effectiveFraction,
      observations: this.observationCount,
    };
  }

  // ---- 内部ヘルパー ----

  /** 面積に対して一様な円盤サンプリング（sqrt を掛けないと中心に偏る） */
  private sampleUniformDisc(centre: Point2, radius: number): Point2 {
    const theta = this.rng.uniform() * TWO_PI;
    const r = radius * Math.sqrt(this.rng.uniform());
    return {
      x: centre.x + r * Math.cos(theta),
      y: centre.y + r * Math.sin(theta),
    };
  }

  /** RSSI 1件に整合する円環上のランダム位置（dB空間で揺らしてから距離変換） */
  private proposeFromRssi(
    dbm: number,
    observer: Point2,
    sigmaDb: number,
    model: PathLossModel
  ): Point2 {
    const noisyDbm = this.rng.normal(dbm, sigmaDb);
    const d = estimateDistance(noisyDbm, model);
    const bearing = this.rng.uniform() * TWO_PI;
    return offsetPoint(observer, bearing, d);
  }

  private proposeFromRange(
    metres: number,
    observer: Point2,
    sigmaM: number
  ): Point2 {
    const d = Math.max(this.rng.normal(metres, sigmaM), 0);
    const bearing = this.rng.uniform() * TWO_PI;
    return offsetPoint(observer, bearing, d);
  }

  /** log-sum-exp トリックによる数値安定な重み正規化 */
  private normalisedWeights(): number[] | null {
    let maxLog = -Infinity;
    for (const lw of this.logWeights) {
      if (lw > maxLog) {
        maxLog = lw;
      }
    }
    if (!Number.isFinite(maxLog)) {
      return null;
    }

    const weights = new Array<number>(this.logWeights.length);
    let total = 0;
    for (let i = 0; i < this.logWeights.length; i++) {
      const w = Math.exp(this.logWeights[i] - maxLog);
      weights[i] = w;
      total += w;
    }
    if (!Number.isFinite(total) || total <= 0) {
      return null;
    }
    for (let i = 0; i < weights.length; i++) {
      weights[i] /= total;
    }
    return weights;
  }

  private recordFitQuality(bestZ: number): void {
    if (Number.isFinite(bestZ) && bestZ > this.config.badFitSigmas) {
      this.consecutiveBadFits += 1;
      if (this.consecutiveBadFits >= this.config.badFitsBeforeDiverged) {
        this.isDiverged = true;
      }
    } else {
      this.consecutiveBadFits = 0;
    }
  }

  private maybeResample(proposeFresh: () => Point2): void {
    const weights = this.normalisedWeights();
    if (!weights) {
      this.logWeights.fill(0);
      this.isDiverged = true;
      return;
    }

    let sumSq = 0;
    for (const w of weights) {
      sumSq += w * w;
    }
    const essFraction = 1 / sumSq / this.particles.length;
    if (essFraction >= this.config.resampleThreshold) {
      return;
    }

    this.systematicResample(weights);

    // 生存粒子が極端に少ないときは最新観測から一部再注入して回復力を保つ
    if (essFraction < this.config.rejuvenateThreshold) {
      const n = this.particles.length;
      const replaceCount = Math.floor(
        n * clamp(this.config.rejuvenateFraction, 0, 1)
      );
      for (let k = 0; k < replaceCount; k++) {
        const victim = Math.floor(this.rng.uniform() * n) % n;
        this.particles[victim] = proposeFresh();
      }
    }
  }

  /** O(N) で低分散な Systematic Resampling + Roughening */
  private systematicResample(weights: readonly number[]): void {
    const n = this.particles.length;
    const step = 1 / n;
    let position = this.rng.uniform() * step;
    let cumulative = weights[0];
    let src = 0;

    const nextParticles = new Array<Point2>(n);
    const rough = this.config.rougheningM;

    for (let i = 0; i < n; i++) {
      while (position > cumulative && src + 1 < n) {
        src += 1;
        cumulative += weights[src];
      }
      const p = this.particles[src];
      nextParticles[i] = {
        x: p.x + this.rng.normal(0, rough),
        y: p.y + this.rng.normal(0, rough),
      };
      position += step;
    }

    this.particles = nextParticles;
    this.logWeights.fill(0);
  }
}
