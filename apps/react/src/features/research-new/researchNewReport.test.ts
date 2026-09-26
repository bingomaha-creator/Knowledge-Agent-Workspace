import { describe, expect, it } from 'vitest';
import { linkReportEvidence } from './researchNewReport';

describe('linkReportEvidence', () => {
  it('numbers cited evidence by first appearance and leaves unknown markers visible', () => {
    expect(linkReportEvidence('结论 [ev_b]，补充 [ev_a]，再次 [ev_b]；未知 [ev_x]。', ['ev_a', 'ev_b'])).toEqual({
      content: '结论 [1](#evidence-ev_b)，补充 [2](#evidence-ev_a)，再次 [1](#evidence-ev_b)；未知 [ev_x]。',
      citedIds: ['ev_b', 'ev_a']
    });
  });

  it('also links the existing Node report evidence markers', () => {
    expect(linkReportEvidence('项目事实 [E1]。', ['E1']).content).toBe('项目事实 [1](#evidence-E1)。');
  });

  it('makes code-wrapped known citations clickable without changing unknown IDs', () => {
    expect(linkReportEvidence('结论 `[ev_a]`，未知 `[ev_unknown]`。', ['ev_a']).content)
      .toBe('结论 [1](#evidence-ev_a)，未知 `[ev_unknown]`。');
  });
});
