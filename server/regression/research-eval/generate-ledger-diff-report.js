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
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeContentHash } from '../../research-evidence-ledger.js';
import { createFixtureAdapters, runEvalCase, runPackThroughDelivery } from './harness.js';
import { resolveBaselineOutputPath } from './output-path.js';

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

function requiredChecks(verdict) {
  return Object.fromEntries(
    (verdict?.checks || [])
      .filter((item) => item.required)
      .map((item) => [item.id, item.passed])
  );
}

function passageSummary(item) {
  const passage = String(item?.passage || '');
  const passageContentHash = computeContentHash(passage);
  if (item?.passageContentHash) {
    assert.equal(item.passageContentHash, passageContentHash,
      `Evidence ${item.id} 的 passageContentHash 与实际 passage 不一致`);
  }
  return {
    passageDigest: passage.slice(0, 120),
    passageLength: passage.length,
    passageContentHash,
    tier: item?.tier || (item?.readerKind === 'search_snippet' ? 'thin' : 'fulltext')
  };
}

function assertNoUndefined(value, label) {
  if (value === undefined) throw new TypeError(`${label} 不得为 undefined`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertNoUndefined(item, `${label}.${key}`);
    }
  }
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
      const subquestionOrder = (task.artifacts.plan?.subquestions || []).map((item) => item.id);
      const oldPack = {
        citations: task.artifacts.citations || [],
        evidence: task.artifacts.evidence || []
      };
      const wouldBePack = {
        citations: ledger.diff?.wouldBeCitations || [],
        evidence: ledger.diff?.wouldBeEvidence || []
      };
      const [oldDelivery, wouldBeDelivery] = await Promise.all([
        runPackThroughDelivery({ pack: oldPack, testCase, writerMode: testCase.fixtures.writer || 'faithful' }),
        runPackThroughDelivery({ pack: wouldBePack, testCase, writerMode: testCase.fixtures.writer || 'faithful' })
      ]);
      // 消费端先断言返回契约字段不是 undefined（Codex 修正第 1 点）
      for (const delivery of [oldDelivery, wouldBeDelivery]) {
        assert.ok(delivery.writerStatus, `${testCase.id} writerStatus 不得为 undefined`);
        assert.ok(typeof delivery.writerStatus.mode === 'string', `${testCase.id} writerStatus.mode 不得缺失`);
        assert.ok(typeof delivery.writerStatus.attempted === 'boolean', `${testCase.id} attempted 不得缺失`);
        assert.ok(typeof delivery.writerStatus.accepted === 'boolean', `${testCase.id} accepted 不得缺失`);
        assert.ok(delivery.verdict, `${testCase.id} verdict 不得为 undefined`);
        assert.ok(typeof delivery.deliveryLegal === 'boolean', `${testCase.id} deliveryLegal 不得缺失`);
      }

      // 逐项差异（含 passage 安全摘要 + passage 内容指纹）
      const diffItems = (ledger.diff?.items || []).map((item) => {
        const wouldBeCitation = wouldBePack.citations.find(
          (citation) => citation.id === item.wouldBeCitationId
        );
        const oldPassages = oldPack.evidence
          .filter((evidence) => evidence.citationId === item.oldCitationId)
          .map(passageSummary);
        const wouldBePassages = wouldBeCitation
          ? wouldBePack.evidence
            .filter((evidence) => evidence.citationId === wouldBeCitation.id)
            .map(passageSummary)
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
              // citation 级汇总指纹（显式命名）；逐段指纹见 passages[].passageContentHash
              selectionContentHash: wouldBeCitation.selectionContentHash || ''
            }
            : null,
          passages: {
            old: oldPassages,
            wouldBe: wouldBePassages
          }
        };
      });

      // 身份完整性自检：来源身份、选段指纹与分类理由不得为空（Spec 可核对性要求）
      for (const citation of wouldBePack.citations) {
        assert.ok(citation.selectionContentHash,
          `${testCase.id} would-be citation ${citation.id} 缺 selectionContentHash`);
      }
      for (const item of diffItems) {
        if (item.wouldBeIdentity) {
          assert.ok(item.wouldBeIdentity.canonicalSourceId, `${testCase.id} would-be 身份缺 canonicalSourceId`);
          assert.ok(item.wouldBeIdentity.selectionContentHash, `${testCase.id} would-be 身份缺 selectionContentHash`);
        }
        assert.ok(item.reason, `${testCase.id} 差异项 ${item.oldCitationId} 缺分类理由`);
        for (const side of ['old', 'wouldBe']) {
          for (const passage of item.passages[side]) {
            assert.ok(passage.passageDigest, `${testCase.id} ${side} passage 摘要不得为空`);
            assert.ok(passage.passageContentHash, `${testCase.id} ${side} passage hash 不得为空`);
          }
        }
      }
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
            selectionContentHash: citation.selectionContentHash || ''
          }))
        },
        diffItems,
        counts: ledger.diff?.counts,
        coverage: ledger.diff?.coverage,
        deliveryComparison: {
          old: {
            deliveryLegal: oldDelivery.deliveryLegal,
            citationValidity: oldDelivery.citationValidity,
            writerStatus: oldDelivery.writerStatus,
            requiredChecks: requiredChecks(oldDelivery.verdict),
            requiredCheckFailures: oldDelivery.verdict.deliveryFailures,
            quality: oldDelivery.quality.quality,
            coverageRatio: oldDelivery.quality.metrics.coverageRatio,
            limitations: (oldDelivery.quality.limitations || []).map((item) => item.code)
          },
          wouldBe: {
            deliveryLegal: wouldBeDelivery.deliveryLegal,
            citationValidity: wouldBeDelivery.citationValidity,
            writerStatus: wouldBeDelivery.writerStatus,
            requiredChecks: requiredChecks(wouldBeDelivery.verdict),
            requiredCheckFailures: wouldBeDelivery.verdict.deliveryFailures,
            quality: wouldBeDelivery.quality.quality,
            coverageRatio: wouldBeDelivery.quality.metrics.coverageRatio,
            limitations: (wouldBeDelivery.quality.limitations || []).map((item) => item.code)
          },
          semanticClaimSupport: 'not_evaluated（人工/Judge 口径，无法离线评估）'
        }
      });
      for (const side of ['old', 'wouldBe']) {
        for (const [checkId, passed] of Object.entries(
          reportCases.at(-1).deliveryComparison[side].requiredChecks
        )) {
          assert.ok([true, false, null].includes(passed),
            `${testCase.id} ${side} required check ${checkId} 必须保留 boolean|null 三态`);
        }
      }
      assertNoUndefined(reportCases.at(-1), `cases.${testCase.id}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const report = {
    diagnostic: 'would_be_pack_diff_report',
    completionMode: 'shadow',
    status: 'pending_review',
    generatedAt: new Date().toISOString(),
    note: '机器验收报告：deliveryLegal 是 shadow 聚合结果，required null/not_evaluated 不表示硬门禁通过。humanReview 保持 pending_review，差异清单须经人工逐项确认后才能判定第二交付门达成。Ledger 保持 shadow。',
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
  // 路径守卫：--case 子集运行只能写 diagnostics，绝不覆盖 canonical 报告。
  const resolvedOutput = resolveBaselineOutputPath({
    baselineDir: outputDir,
    partialRun: Boolean(caseFilter),
    caseIds: selectedCases.map((item) => item.id),
    timestamp: new Date(),
    fileName: 'ledger-would-be-diff-report.json'
  });
  const outputPath = resolvedOutput.path;
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`差异报告已写入 ${outputPath}（status=pending_review，共 ${reportCases.length} 个 case）`);
  for (const item of reportCases) {
    const counts = item.counts || {};
    console.log(
      `[report] ${item.caseId}: unexpectedLoss=${counts.unexpectedLoss ?? 0}` +
      ` keptFulltext=${counts.keptFulltext ?? 0} keptThin=${counts.keptThin ?? 0} downgraded=${counts.downgraded ?? 0}` +
      ` coverage ${item.coverage.old}→${item.coverage.wouldBe}`
    );
  }
}

await main();
