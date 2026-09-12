/**
 * Phase 2A 第二交付门：Ledger would-be Evidence Pack 差异报告生成器（显式命令）。
 *
 * 用 Phase 0 case 集逐例对比旧 Evidence Pack 与 Ledger would-be Pack，输出
 * 机器可读且可人工复核的差异报告（baselines/ledger-would-be-diff-report.json）。
 *
 * 报告的 humanReview 字段固定为 pending_review——机器只能生成待复核报告，
 * 不能自行把人工复核门槛标为通过；reviewer/reviewedAt/decision/notes 由
 * 用户/Codex 复核后填写。
 *
 * 用法：npm run eval:ledger-report [-- --case <id>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureAdapters, runEvalCase, runPackThroughDelivery } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const caseFilter = (() => {
  const index = process.argv.indexOf('--case');
  return index >= 0 ? process.argv[index + 1] : null;
})();

const casesDir = path.join(here, 'cases');
const allCases = fs.readdirSync(casesDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .flatMap((name) => JSON.parse(fs.readFileSync(path.join(casesDir, name), 'utf8')).cases);
const selectedCases = caseFilter ? allCases.filter((item) => item.id === caseFilter) : allCases;
if (!selectedCases.length) {
  console.error(`没有匹配的评测 case：${caseFilter || '(空 case 集)'}`);
  process.exit(2);
}

async function main() {
  const reportCases = [];
  for (const testCase of selectedCases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-report-'));
    const dbPath = path.join(dir, 'report.sqlite');
    try {
      const run = await runEvalCase({
        testCase,
        adapters: createFixtureAdapters(testCase),
        mode: 'fixture',
        dbPath,
        includeLedger: true
      });
      const { task, ledger } = run;
      const planSubquestions = (task.artifacts.plan?.subquestions || []);
      const subquestionOrder = planSubquestions.map((item) => item.id);
      const oldPack = {
        citations: task.artifacts.citations || [],
        evidence: task.artifacts.evidence || []
      };
      const wouldBePack = {
        citations: ledger.diff?.wouldBeCitations || [],
        evidence: ledger.diff?.wouldBeEvidence || []
      };
      const oldDelivery = runPackThroughDelivery({
        pack: oldPack,
        question: testCase.question,
        searchMode: testCase.searchMode,
        subquestions: planSubquestions
      });
      const wouldBeDelivery = runPackThroughDelivery({
        pack: wouldBePack,
        question: testCase.question,
        searchMode: testCase.searchMode,
        subquestions: planSubquestions
      });

      // 逐项差异（含 passage 安全摘要 + passage 内容指纹）
      const diffItems = (ledger.diff?.items || []).map((item) => {
        const wouldBeCitation = wouldBePack.citations.find(
          (citation) => citation.id === item.wouldBeCitationId
        );
        const passages = wouldBeCitation
          ? wouldBePack.evidence
            .filter((item) => item.citationId === wouldBeCitation.id)
            .map((item) => ({
              passageDigest: item.passage.slice(0, 120),
              passageLength: item.passage.length,
              tier: item.tier
            }))
          : [];
        return {
          ...item,
          oldIdentity: {
            citationId: item.oldCitationId,
            url: oldPack.citations.find((citation) => citation.id === item.oldCitationId)?.url || ''
          },
          wouldBeIdentity: wouldBeCitation
            ? {
              citationId: wouldBeCitation.id,
              evidenceId: wouldBeCitation.sourceEntryId,
              canonicalSourceId: wouldBeCitation.canonicalSourceId || '',
              tier: wouldBeCitation.tier,
              passageContentHash: wouldBeCitation.passageContentHash
            }
            : null,
          passages
        };
      });

      reportCases.push({
        caseId: testCase.id,
        searchMode: testCase.searchMode,
        oldIdentity: {
          citations: oldPack.citations.map((citation) => ({
            citationId: citation.id,
            url: citation.url || '',
            title: citation.title || ''
          }))
        },
        wouldBeIdentity: {
          citations: wouldBePack.citations.map((citation) => ({
            citationId: citation.id,
            evidenceId: citation.sourceEntryId,
            canonicalSourceId: citation.canonicalSourceId || '',
            canonicalUrl: citation.canonicalUrl || '',
            tier: citation.tier,
            passageContentHash: citation.passageContentHash
          }))
        },
        diffItems,
        counts: ledger.diff?.counts,
        coverage: ledger.diff?.coverage,
        deliveryComparison: {
          old: {
            deliveryLegal: oldDelivery.deliveryLegal,
            citationValidity: oldDelivery.citationValidity,
            writerMode: oldDelivery.writer.mode,
            requiredCheckFailures: oldDelivery.verdict.deliveryFailures,
            quality: oldDelivery.quality.quality,
            coverageRatio: oldDelivery.quality.metrics.coverageRatio,
            limitations: (oldDelivery.quality.limitations || []).map((item) => item.code)
          },
          wouldBe: {
            deliveryLegal: wouldBeDelivery.deliveryLegal,
            citationValidity: wouldBeDelivery.citationValidity,
            writerMode: wouldBeDelivery.writer.mode,
            requiredCheckFailures: wouldBeDelivery.verdict.deliveryFailures,
            quality: wouldBeDelivery.quality.quality,
            coverageRatio: wouldBeDelivery.quality.metrics.coverageRatio,
            limitations: (wouldBeDelivery.quality.limitations || []).map((item) => item.code)
          },
          semanticClaimSupport: 'not_evaluated（人工/Judge 口径，无法离线评估）'
        }
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const report = {
    diagnostic: 'would_be_pack_diff_report',
    status: 'pending_review',
    generatedAt: new Date().toISOString(),
    note: '机器验收报告：humanReview 字段为 pending_review，人工复核（差异清单逐项确认）由用户/Codex 执行后才可判定第二交付门达成。Ledger 保持 shadow。',
    humanReview: {
      reviewer: null,
      reviewedAt: null,
      decision: 'pending_review',
      notes: ''
    },
    cases: reportCases
  };

  const outputDir = path.join(here, 'baselines');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'ledger-would-be-diff-report.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`差异报告已写入 ${outputPath}（status=pending_review，共 ${reportCases.length} 个 case）`);
  for (const item of reportCases) {
    const counts = item.counts || {};
    console.log(
      `[report] ${item.caseId}: unexpectedLoss=${counts.unexpectedLoss ?? 0}` +
      ` keptFulltext=${counts.keptFulltext ?? 0} keptThinDowngraded=${counts.keptThinDowngraded ?? 0}` +
      ` coverage ${item.coverage.old}→${item.coverage.wouldBe}`
    );
  }
}

await main();
