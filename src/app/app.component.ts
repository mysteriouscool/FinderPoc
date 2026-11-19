import { Component } from '@angular/core';
import { RadarTrackerService } from './radar';

/**
 * 計算ロジック確認用の最小コンポーネント。
 * 実際の画面を組み込む際は `radar.snapshot$` を購読してください。
 */
@Component({
  selector: 'app-root',
  template: `
    <main style="font-family: monospace; padding: 16px;">
      <h1>Superfind Radar Core (Angular v13 / TypeScript)</h1>
      <p>計算ロジックは <code>src/app/radar/</code> に実装されています。</p>
      <pre>{{ radar.snapshot$ | async | json }}</pre>
    </main>
  `,
})
export class AppComponent {
  constructor(public readonly radar: RadarTrackerService) {}
}
