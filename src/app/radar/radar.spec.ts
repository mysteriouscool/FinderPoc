import {
  angleDiff,
  bearingBetween,
  BearingEstimator,
  BLE_PROFILE,
  covarianceToEllipse,
  distanceBetween,
  estimateDistance,
  expectedRssi,
  fitPathLoss,
  isPathLossPlausible,
  offsetPoint,
  ParticleFilter,
  pathLossResidualRms,
  Point2,
  RadarTrackerService,
  RFID_UHF_PROFILE,
  rssiLogLikelihood,
  sectorCentre,
  sectorOf,
  SeededRng,
  toDegrees,
  toRadians,
} from './index';

describe('Radar Math & PathLoss', () => {
  it('コンパス方位とオフセット計算が互いに逆変換になる', () => {
    const start: Point2 = { x: 2, y: -3 };
    for (const deg of [0, 45, 90, 180, -90, 315]) {
      const rad = toRadians(deg);
      const next = offsetPoint(start, rad, 5.0);
      expect(distanceBetween(start, next)).toBeCloseTo(5.0, 6);
      expect(Math.abs(angleDiff(bearingBetween(start, next), rad))).toBeLessThan(1e-6);
    }
  });

  it('パスロスモデルの距離変換が往復一致し、真の距離で対数尤度が最大になる', () => {
    const model = RFID_UHF_PROFILE.pathLoss;
    expect(expectedRssi(1.0, model)).toBeCloseTo(model.txPower1m, 6);

    for (const d of [0.5, 1.0, 2.5, 6.0]) {
      const rssi = expectedRssi(d, model);
      expect(estimateDistance(rssi, model)).toBeCloseTo(d, 5);
    }

    const truthM = 3.0;
    const obsDbm = expectedRssi(truthM, model);
    const best = rssiLogLikelihood(obsDbm, truthM, 5.0, model);
    for (const wrong of [0.8, 1.5, 5.0, 10.0]) {
      expect(rssiLogLikelihood(obsDbm, wrong, 5.0, model)).toBeLessThan(best);
    }
  });

  it('最小二乗法でRFIDのパスロスパラメータを校正でき、残差RMSを評価できる', () => {
    const truth = { txPower1m: -48.0, exponent: 3.8 };
    const samples = [0.5, 1.0, 2.0, 4.0, 8.0].map((d) => ({
      distanceM: d,
      rssiDbm: expectedRssi(d, truth),
    }));
    const fitted = fitPathLoss(samples);
    expect(fitted).not.toBeNull();
    expect(fitted!.txPower1m).toBeCloseTo(truth.txPower1m, 5);
    expect(fitted!.exponent).toBeCloseTo(truth.exponent, 5);
    expect(isPathLossPlausible(fitted!)).toBeTrue();
    expect(pathLossResidualRms(fitted!, samples)!).toBeLessThan(1e-6);

    // 同一距離のみでは傾きが出せないため null
    expect(
      fitPathLoss([
        { distanceM: 2.0, rssiDbm: -60 },
        { distanceM: 2.0, rssiDbm: -62 },
      ])
    ).toBeNull();
  });

  it('2x2共分散行列から正しい95%信頼楕円と向きを算出する', () => {
    // x方向（東=90°）に広い分布
    const ellipse = covarianceToEllipse({ x: 0, y: 0 }, 25, 0, 1);
    expect(ellipse.semiMajorM).toBeGreaterThan(ellipse.semiMinorM);
    expect(Math.abs(toDegrees(ellipse.orientationRad))).toBeCloseTo(90, 4);
  });
});

describe('BearingEstimator (合成開口セクター方位推定)', () => {
  it('全周スキャンでRFID指向性/人体遮蔽ピークの方位を正しく推定できる', () => {
    for (const truthDeg of [0, 60, 135, 225, 310]) {
      const est = new BearingEstimator(16, 5.0);
      const truthRad = toRadians(truthDeg);
      for (let deg = 0; deg < 360; deg += 5) {
        const facing = toRadians(deg);
        const alignment = Math.cos(angleDiff(facing, truthRad));
        // 正面で -50 dBm、背後で -62 dBm（12 dB コントラスト）
        const rssi = -50 - 12 * ((1 - alignment) / 2);
        for (let k = 0; k < 6; k++) {
          est.observe(rssi, facing);
        }
      }
      const result = est.estimate();
      expect(result).not.toBeNull();
      const errDeg = Math.abs(toDegrees(angleDiff(result!.bearingRad, truthRad)));
      expect(errDeg).toBeLessThan(20);
      expect(result!.confidence).toBeGreaterThan(0.4);
    }
  });

  it('1セクターのみでは方位を返さず、狭いスキャンでは信頼度を低く抑える', () => {
    const est = new BearingEstimator(16, 5.0);
    expect(est.estimate()).toBeNull();

    est.observe(-50, toRadians(10));
    expect(est.estimate()).toBeNull();

    // 隣接する2セクターだけを大量スキャンしても coverage が低いため信頼度は低い
    for (let i = 0; i < 100; i++) {
      est.observe(-40, toRadians(10));
      est.observe(-75, toRadians(35));
    }
    const narrow = est.estimate();
    expect(narrow).not.toBeNull();
    expect(narrow!.coverage).toBeLessThan(0.2);
    expect(narrow!.confidence).toBeLessThan(0.25);
  });

  it('セクター番号と中心方位が全周で整合する', () => {
    for (let i = 0; i < 16; i++) {
      expect(sectorOf(sectorCentre(i, 16), 16)).toBe(i);
    }
  });
});

describe('ParticleFilter (2Dパーティクルフィルタ)', () => {
  it('観測前は null を返し、1地点観測だけではリング状に広がり低信頼度になる', () => {
    const pf = new ParticleFilter({ particleCount: 512 }, { x: 0, y: 0 }, 7);
    expect(pf.getFix({ x: 0, y: 0 })).toBeNull();

    const model = RFID_UHF_PROFILE.pathLoss;
    pf.updateRssi(expectedRssi(4.0, model), { x: 0, y: 0 }, 5.0, model);
    const fix = pf.getFix({ x: 0, y: 0 });
    expect(fix).not.toBeNull();
    expect(fix!.ellipse.semiMajorM).toBeGreaterThan(2.5);
    expect(fix!.bearingSigmaRad).toBeGreaterThan(1.0);
  });

  it('L字（ドッグレッグ）歩行しながらRFID RSSIを観測するとタグ位置に収束する', () => {
    const truth: Point2 = { x: 5.0, y: 4.0 };
    const model = RFID_UHF_PROFILE.pathLoss;
    const rng = new SeededRng(42);
    const pf = new ParticleFilter(
      { particleCount: 1024, initRadiusM: 15.0 },
      { x: 0, y: 0 },
      101
    );

    // 東へ6m、その後北へ6m歩く
    const user: Point2 = { x: 0, y: 0 };
    for (let leg = 0; leg < 2; leg++) {
      for (let step = 0; step < 8; step++) {
        if (leg === 0) {
          user.x += 0.75;
        } else {
          user.y += 0.75;
        }
        pf.predict(0.8);
        for (let k = 0; k < 4; k++) {
          const dbm =
            expectedRssi(distanceBetween(user, truth), model) + rng.normal(0, 3.0);
          pf.updateRssi(dbm, { ...user }, 4.5, model);
        }
      }
    }

    const fix = pf.getFix(user);
    expect(fix).not.toBeNull();
    expect(distanceBetween(fix!.position, truth)).toBeLessThan(2.5);
    expect(pf.diverged).toBeFalse();
  });

  it('直線歩行のみでは鏡像曖昧性（左右対称の2峰）が残り、過信しない', () => {
    const truth: Point2 = { x: 4.0, y: -5.0 };
    const mirrored: Point2 = { x: 4.0, y: 5.0 };
    const pf = new ParticleFilter({ particleCount: 1024, initRadiusM: 15 }, { x: 0, y: 0 }, 19);

    // y = 0 上を東へ直進しながら正確な距離観測のみを与える
    for (let i = 0; i < 12; i++) {
      const user: Point2 = { x: i * 0.8, y: 0 };
      for (let k = 0; k < 3; k++) {
        pf.updateRange(distanceBetween(user, truth), user, 0.3);
      }
    }

    const fix = pf.getFix({ x: 8.8, y: 0 });
    expect(fix).not.toBeNull();
    expect(Math.abs(fix!.position.x - truth.x)).toBeLessThan(1.5);
    expect(fix!.ellipse.semiMajorM).toBeGreaterThan(2.5);
    expect(fix!.confidence).toBeLessThan(0.75);

    const particles = pf.getParticles();
    const nearTruth = particles.filter((p) => distanceBetween(p, truth) < 2.5).length;
    const nearMirror = particles.filter((p) => distanceBetween(p, mirrored) < 2.5).length;
    expect(nearTruth).toBeGreaterThan(particles.length * 0.05);
    expect(nearMirror).toBeGreaterThan(particles.length * 0.05);
  });

  it('数千回の更新でも対数重みがアンダーフローせず安定動作する', () => {
    const truth: Point2 = { x: 3.0, y: 3.0 };
    const model = RFID_UHF_PROFILE.pathLoss;
    const rng = new SeededRng(99);
    const pf = new ParticleFilter({ particleCount: 512, initRadiusM: 15 }, { x: 0, y: 0 }, 17);

    for (let i = 0; i < 1500; i++) {
      const user: Point2 = { x: (i % 6) * 1.0, y: (Math.floor(i / 6) % 6) * 1.0 };
      const dbm =
        expectedRssi(distanceBetween(user, truth), model) + rng.normal(0, 3.5);
      pf.updateRssi(dbm, user, 5.0, model);
    }

    expect(pf.diverged).toBeFalse();
    const fix = pf.getFix({ x: 2, y: 2 });
    expect(fix).not.toBeNull();
    expect(Number.isFinite(fix!.position.x)).toBeTrue();
    expect(distanceBetween(fix!.position, truth)).toBeLessThan(2.5);
  });
});

describe('RadarTrackerService (統合ファサード・RFID/BLE対応)', () => {
  it('外れ値スパイクを中央値で除去し、高優先度ソースを優先する', () => {
    const service = new RadarTrackerService();
    service.configure(BLE_PROFILE);

    // 反射スパイク -20 dBm が混ざっても中央値 -70 dBm を維持
    [-70, -71, -20, -70, -72].forEach((dbm, i) => {
      service.observe({ dbm, timestampSec: i * 0.2, priority: 0 });
    });
    expect(service.getSnapshot(1.0).rssiDbm).toBe(-70);

    // 高頻度の低信頼ソース(priority=1)より高信頼ソース(priority=0)が勝つ
    service.reset(2.0);
    for (let i = 0; i < 20; i++) {
      service.observe({ dbm: -82, timestampSec: 2.0 + i * 0.05, priority: 1 });
    }
    for (let i = 0; i < 3; i++) {
      service.observe({ dbm: -55, timestampSec: 3.0 + i * 0.1, priority: 0 });
    }
    const snap = service.getSnapshot(3.5);
    expect(snap.rssiDbm).toBe(-55);
    expect(snap.samplesInWindow).toBe(3);
  });

  it('無信号(stale)の時だけガイガーフィードバックが無音になり、遠距離では鳴り続ける', () => {
    const service = new RadarTrackerService();
    service.configure(RFID_UHF_PROFILE);

    service.observe({ dbm: -82, timestampSec: 0.0 });
    const weakLive = service.getSnapshot(0.5);
    expect(weakLive.isFresh).toBeTrue();
    expect(weakLive.proximityCue).not.toBeNull();

    const stale = service.getSnapshot(20.0);
    expect(stale.isFresh).toBeFalse();
    expect(stale.proximityCue).toBeNull();
  });

  it('接近・離反のトレンド(warmer/colder)と異常RSSI除外が機能する', () => {
    const service = new RadarTrackerService();
    service.configure(RFID_UHF_PROFILE);

    // 範囲外異常値（BLE HCI -127や正の値）は拒否される
    expect(service.observe({ dbm: -127, timestampSec: 0.0 })).toBeFalse();
    expect(service.observe({ dbm: 5, timestampSec: 0.1 })).toBeFalse();
    expect(service.getSnapshot(0.2).totalSamples).toBe(0);

    // -75 dBm → -52 dBm へ接近
    for (let i = 0; i < 6; i++) {
      service.observe({ dbm: -75, timestampSec: i * 0.5 });
    }
    for (let i = 0; i < 6; i++) {
      service.observe({ dbm: -52, timestampSec: 6.0 + i * 0.2 });
    }
    expect(service.getSnapshot(7.5).trend).toBe('warmer');
  });

  it('複数RFIDリーダー（3地点の固定アンカー）観測で歩かずに位置を特定できる', () => {
    const service = new RadarTrackerService();
    service.configure(RFID_UHF_PROFILE, { particleCount: 1024, seed: 2027 });

    const truth: Point2 = { x: 4.5, y: 2.5 };
    const model = RFID_UHF_PROFILE.pathLoss;
    const readers: Point2[] = [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 3, y: 7 },
    ];
    const rng = new SeededRng(333);

    let t = 0;
    for (let round = 0; round < 60; round++) {
      t += 0.1;
      for (const reader of readers) {
        const dbm =
          expectedRssi(distanceBetween(reader, truth), model) + rng.normal(0, 2.5);
        service.observeFrom({ dbm, timestampSec: t }, reader, false);
      }
    }

    const snap = service.getSnapshot(t);
    expect(snap.fix).not.toBeNull();
    expect(distanceBetween(snap.fix!.position, truth)).toBeLessThan(1.5);
    expect(snap.remoteObservations).toBe(180);
    // 他リーダー観測はローカル表示を汚さない
    expect(snap.rssiDbm).toBeNull();
  });
});
