import { BearingEstimate } from './radar.models';
import { clamp, TWO_PI, wrapAngle, wrapPositive } from './radar-math';

/**
 * 合成開口（Synthetic Aperture）による方位推定器。
 *
 * 【レーダーアルゴリズムの核心】
 * 360度を N 個のセクター（例: 16分割 = 22.5度幅）に分け、向いていた方位ごとの
 * 平均RSSIを記録する。
 *
 * - BLEの場合: 無指向性アンテナなので「人体による電波遮蔽（5〜15dB減衰）」を利用し、
 *   その場で一回転するとタグ方向が最も強く、背中側が弱くなる。
 * - RFIDの場合: ハンディリーダーの「指向性アンテナ」により、タグに向けた方向のRSSIが
 *   より明確に強くなるため、同じ数式がそのまま（しかもより高精度に）機能する。
 *
 * 【信頼度の3要素（平均ではなく積で計算）】
 *   confidence = coverage × concentration × significance
 *   1. coverage      : どれだけ全方位をスキャンしたか（狭い角度だけでは信用しない）
 *   2. concentration : 平均超過信号が1方向に集中しているか（円統計の合成ベクトル長）
 *   3. significance  : ピークと平均の差が電波ノイズを有意に上回っているか
 * どれか1つでも 0 に近ければ信頼度全体が 0 に落ち、誤った矢印を出さない。
 */

interface SectorBucket {
  sum: number;
  count: number;
}

/** コンパス方位 headingRad が属するセクター番号 (0..sectors-1) */
export function sectorOf(headingRad: number, sectors: number): number {
  if (sectors <= 0) {
    return 0;
  }
  const width = TWO_PI / sectors;
  const idx = Math.floor(wrapPositive(headingRad) / width);
  return Math.min(idx, sectors - 1);
}

/** セクター番号 index の中心方位（ラジアン、-π..π） */
export function sectorCentre(index: number, sectors: number): number {
  if (sectors <= 0) {
    return 0;
  }
  const width = TWO_PI / sectors;
  return wrapAngle((index + 0.5) * width);
}

export class BearingEstimator {
  private readonly sectors: SectorBucket[];
  private readonly noiseDb: number;
  private sampleCount = 0;

  constructor(sectorCount = 16, noiseDb = 5.0) {
    const n = Math.max(Math.floor(sectorCount), 1);
    this.sectors = Array.from({ length: n }, () => ({ sum: 0, count: 0 }));
    this.noiseDb = Math.max(noiseDb, 0.5);
  }

  get sectorCount(): number {
    return this.sectors.length;
  }

  get samples(): number {
    return this.sampleCount;
  }

  /** 全セクターの記録をクリア（別の場所へ移動して再スキャンしたい時など） */
  clear(): void {
    for (const bucket of this.sectors) {
      bucket.sum = 0;
      bucket.count = 0;
    }
    this.sampleCount = 0;
  }

  /** 方位 headingRad を向いているときに得た RSSI を記録 */
  observe(rssiDbm: number, headingRad: number): void {
    if (!Number.isFinite(rssiDbm) || !Number.isFinite(headingRad)) {
      return;
    }
    const idx = sectorOf(headingRad, this.sectors.length);
    this.sectors[idx].sum += rssiDbm;
    this.sectors[idx].count += 1;
    this.sampleCount += 1;
  }

  /** セクターごとの平均RSSI（未観測セクターは null → レーダーの未探索領域表示用） */
  sectorMeans(): (number | null)[] {
    return this.sectors.map((s) => (s.count > 0 ? s.sum / s.count : null));
  }

  /** 全セクターのうち1回以上観測した割合 (0..1) */
  coverage(): number {
    let filled = 0;
    for (const s of this.sectors) {
      if (s.count > 0) {
        filled++;
      }
    }
    return filled / this.sectors.length;
  }

  /**
   * 推定方位を算出する。
   * 2セクター以上スキャンされていない場合は比較対象がないため null を返す。
   */
  estimate(): BearingEstimate | null {
    const filled: Array<{ index: number; mean: number }> = [];
    for (let i = 0; i < this.sectors.length; i++) {
      const s = this.sectors[i];
      if (s.count > 0) {
        filled.push({ index: i, mean: s.sum / s.count });
      }
    }
    if (filled.length < 2) {
      return null;
    }

    let overallSum = 0;
    let peak = -Infinity;
    for (const item of filled) {
      overallSum += item.mean;
      if (item.mean > peak) {
        peak = item.mean;
      }
    }
    const overallMean = overallSum / filled.length;
    const contrastDb = peak - overallMean;

    // 全体平均より強いセクターだけを「超過分(excess)」で重み付けし、円加重平均を求める
    let sinSum = 0;
    let cosSum = 0;
    let weightSum = 0;
    for (const item of filled) {
      const excess = item.mean - overallMean;
      if (excess <= 0) {
        continue;
      }
      const theta = sectorCentre(item.index, this.sectors.length);
      sinSum += excess * Math.sin(theta);
      cosSum += excess * Math.cos(theta);
      weightSum += excess;
    }

    if (weightSum <= 0) {
      return null;
    }

    // 隣接セクター間を滑らかに補間した推定方位
    const bearingRad = wrapAngle(Math.atan2(sinSum, cosSum));

    // 1) 集中度 (Resultant length): 全超過分が1方向なら1、全方位均等や反対2方向なら0付近
    const concentration = clamp(Math.hypot(sinSum, cosSum) / weightSum, 0, 1);

    // 2) カバレッジ: スキャン済みセクター比率
    const coverage = this.coverage();

    // 3) 統計的有意性: コントラストが標準誤差 (noise / sqrt(n)) の2倍を超えているか
    const meanSamplesPerSector = Math.max(this.sampleCount / filled.length, 1);
    const standardError = this.noiseDb / Math.sqrt(meanSamplesPerSector);
    const significance = clamp(contrastDb / (2 * standardError), 0, 1);

    // 3要素の積（1つでも弱ければ信頼度を下げる）
    const confidence = clamp(concentration * coverage * significance, 0, 1);

    // 角度の広がり（円標準偏差）。ビン分解能（半セクター幅）より狭くは主張しない
    const halfSector = TWO_PI / this.sectors.length / 2;
    const spread = Math.sqrt(-2 * Math.log(clamp(concentration, 1e-6, 1)));
    const sigmaRad = Math.max(spread, halfSector);

    return {
      bearingRad,
      sigmaRad,
      confidence,
      coverage,
      contrastDb,
      samples: this.sampleCount,
    };
  }
}
