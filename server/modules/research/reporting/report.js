function normalizeQuestion(question) {
  return String(question || '').replace(/\s+/g, ' ').trim();
}
function safeSourceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function escapeMarkdownText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]{}()#+.!|>\-])/g, '\\$1');
}

function shortHeading(value, index) {
  const normalized = normalizeQuestion(value).replace(/[?？]$/, '');
  return `${index + 1}. ${normalized.slice(0, 72)}`;
}

export function buildOutline(subquestions) {
  return [
    { id: 'scope', heading: '研究范围与方法', purpose: '说明问题边界、资料范围和检索方式。' },
    ...subquestions.map((question, index) => ({
      id: `question-${index + 1}`,
      heading: shortHeading(question, index),
      purpose: '用可验证的资料回答该子问题。',
      question
    })),
    { id: 'conclusion', heading: '综合结论、限制与下一步', purpose: '汇总已有证据并显式说明资料缺口。' }
  ];
}

export function buildSections(task, artifacts) {
  const subquestions = Array.isArray(artifacts.subquestions) ? artifacts.subquestions : [];
  const evidence = Array.isArray(artifacts.evidence) ? artifacts.evidence : [];
  const sections = subquestions.map((question, index) => {
    const related = evidence
      .filter((item) => item.queries.includes(question))
      .slice(0, 6);
    const content = related.length
      ? related
        .map((item) => `${escapeMarkdownText(item.claim)} [${item.citationNumber}]`)
        .join('\n\n')
      : '当前可用资料中没有找到可直接支撑该子问题的证据。';
    return {
      id: `question-${index + 1}`,
      heading: shortHeading(question, index),
      question,
      content,
      citationNumbers: related.map((item) => item.citationNumber)
    };
  });

  const searchDescription = task.searchMode === 'local'
    ? '仅检索本地知识库'
    : '按请求执行本地与受控联网检索；联网不可用时保留本地结果';
  const scope = task.knowledgeBaseIds.length
    ? task.knowledgeBaseIds.join('、')
    : '未选择本地知识库';
  const report = [
    '# 异步深度研究报告',
    '',
    `> 研究问题：${escapeMarkdownText(task.question)}`,
    '',
    '## 研究范围与方法',
    '',
    `本次研究${searchDescription}。本地范围：${escapeMarkdownText(scope)}。`,
    '',
    ...sections.flatMap((section) => [
      `## ${escapeMarkdownText(section.heading)}`,
      '',
      section.content,
      ''
    ]),
    '## 综合结论、限制与下一步',
    '',
    evidence.length
      ? `报告共整理 ${evidence.length} 条可追溯证据。结论应以上述引用为边界，对未命中资料的部分继续补充一手来源。`
      : '本次检索没有命中可引用资料，因此不作事实性推断；建议扩充本地知识库或配置受控联网检索后重试。'
  ].join('\n');
  return { sections, report };
}

export function verifyReport(report, citations) {
  const validNumbers = new Set(citations.map((citation) => citation.index));
  const referencedNumbers = new Set();
  const invalidCitationNumbers = [];
  const invalidCitationMarkers = [];
  const numericChecked = String(report || '').replace(/\[(\d+)\]/g, (match, rawNumber) => {
    const number = Number(rawNumber);
    if (validNumbers.has(number)) {
      referencedNumbers.add(number);
      return match;
    }
    invalidCitationNumbers.push(number);
    return `〔无效引用 ${number}〕`;
  });
  const verifiedBody = numericChecked.replace(/\[([a-z][a-z0-9_-]*)\]/giu, (_match, marker) => {
    invalidCitationMarkers.push(marker);
    return `〔无效引用 ${escapeMarkdownText(marker)}〕`;
  });
  const sourceLines = citations.length
    ? citations.flatMap((citation) => {
      const url = safeSourceUrl(citation.url);
      const escapedTitle = escapeMarkdownText(citation.title || '未命名资料');
      const title = url ? `[${escapedTitle}](<${url}>)` : escapedTitle;
      return [
        `[${citation.index}] **${title}** — ${escapeMarkdownText(citation.source || '未知来源')}`,
        `   ${escapeMarkdownText(citation.snippet || '未提供摘要')}`,
        ''
      ];
    })
    : ['本次研究没有可列出的参考资料。'];
  const uniqueInvalid = [...new Set(invalidCitationNumbers)];
  return {
    report: [
      verifiedBody.trim(),
      '',
      '## 参考资料',
      '',
      ...sourceLines
    ].join('\n').trim(),
    verification: {
      valid: uniqueInvalid.length === 0 && invalidCitationMarkers.length === 0,
      referencedCitationIds: citations
        .filter((citation) => referencedNumbers.has(citation.index))
        .map((citation) => citation.id),
      invalidCitationNumbers: uniqueInvalid,
      invalidCitationMarkers: [...new Set(invalidCitationMarkers)],
      unreferencedCitationIds: citations
        .filter((citation) => !referencedNumbers.has(citation.index))
        .map((citation) => citation.id)
    }
  };
}
