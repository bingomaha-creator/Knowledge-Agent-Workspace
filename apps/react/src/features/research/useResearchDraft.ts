import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResearchSearchMode, ResearchTask } from '@/services/researchApi';
import {
  externalSearchFromSearchMode,
  resolveResearchSearchMode,
  type ResearchDraftValues,
  type ResearchSubmitGates
} from './researchViewState';

export type ResearchDraftSeedInput = Partial<ResearchDraftValues> & {
  fromChat?: boolean;
  sourceHint?: string;
};

export type ResearchDraftSnapshot = {
  question: string;
  searchMode: ResearchSearchMode;
  knowledgeBaseIds: string[];
};

const BLANK_DRAFT: ResearchDraftValues = { question: '', knowledgeBaseIds: [], externalSearch: false };

function draftValuesFromSeed(seed: ResearchDraftSeedInput | undefined): ResearchDraftValues {
  return {
    question: seed?.question ?? '',
    knowledgeBaseIds: [...(seed?.knowledgeBaseIds ?? [])],
    externalSearch: seed?.externalSearch ?? false
  };
}

type ResearchDraftCore = {
  values: ResearchDraftValues;
  submitting: boolean;
  error: string;
  setQuestion: (question: string) => void;
  setExternalSearch: (value: boolean) => void;
  toggleKnowledgeBase: (id: string) => void;
  pruneKnowledgeBaseIds: (knownIds: ReadonlySet<string>) => void;
  setError: (message: string) => void;
  /** 统一校验入口：问题必填 + searchMode 门控（能力与有效内部来源）。 */
  beginSubmit: (gates: ResearchSubmitGates) => ResearchDraftSnapshot | null;
  endSubmit: () => void;
  replaceValues: (values: ResearchDraftValues) => void;
};

/**
 * 新建草稿与 follow-up 草稿共享的字段、校验与提交生命周期；
 * 成功、失败、清理与重新初始化都经由同一组状态迁移，避免提交状态失同步。
 */
function useResearchDraftCore(initialValues: ResearchDraftValues): ResearchDraftCore {
  const [values, setValues] = useState(initialValues);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const setQuestion = useCallback((question: string) => {
    setValues((current) => ({ ...current, question }));
  }, []);

  const setExternalSearch = useCallback((externalSearch: boolean) => {
    setValues((current) => ({ ...current, externalSearch }));
  }, []);

  const toggleKnowledgeBase = useCallback((id: string) => {
    setValues((current) => ({
      ...current,
      knowledgeBaseIds: current.knowledgeBaseIds.includes(id)
        ? current.knowledgeBaseIds.filter((value) => value !== id)
        : [...current.knowledgeBaseIds, id]
    }));
  }, []);

  /** 移除已不存在或已失效的资料库 ID（列表加载完成后调用），无可移除时不产生更新。 */
  const pruneKnowledgeBaseIds = useCallback((knownIds: ReadonlySet<string>) => {
    setValues((current) => {
      const next = current.knowledgeBaseIds.filter((id) => knownIds.has(id));
      return next.length === current.knowledgeBaseIds.length
        ? current
        : { ...current, knowledgeBaseIds: next };
    });
  }, []);

  const beginSubmit = useCallback((gates: ResearchSubmitGates): ResearchDraftSnapshot | null => {
    const trimmed = values.question.trim();
    if (!trimmed) {
      setError('请输入研究问题。');
      return null;
    }
    if (trimmed.length > 4000) {
      // 保留原文交由用户修改，不静默截断。
      setError('研究问题超过 4000 字上限，请删减后再提交。');
      return null;
    }
    const searchMode = resolveResearchSearchMode(values, gates);
    if (!searchMode) {
      setError(gates.externalSearchAllowed
        ? '请选择至少一个可检索的资料库，或开启外部检索后再提交。'
        : '外部检索当前不可用；请选择至少一个可检索的资料库后再提交。');
      return null;
    }
    setError('');
    setSubmitting(true);
    return { question: trimmed, searchMode, knowledgeBaseIds: [...values.knowledgeBaseIds] };
  }, [values]);

  const endSubmit = useCallback(() => setSubmitting(false), []);

  const replaceValues = useCallback((next: ResearchDraftValues) => {
    setValues(next);
    setSubmitting(false);
    setError('');
  }, []);

  return {
    values,
    submitting,
    error,
    setQuestion,
    setExternalSearch,
    toggleKnowledgeBase,
    pruneKnowledgeBaseIds,
    setError,
    beginSubmit,
    endSubmit,
    replaceValues
  };
}

export type ResearchDraftController = ResearchDraftValues & {
  submitting: boolean;
  error: string;
  fromChat: boolean;
  setQuestion: (question: string) => void;
  setExternalSearch: (value: boolean) => void;
  toggleKnowledgeBase: (id: string) => void;
  pruneKnowledgeBaseIds: (knownIds: ReadonlySet<string>) => void;
  setError: (message: string) => void;
  beginSubmit: (gates: ResearchSubmitGates) => ResearchDraftSnapshot | null;
  endSubmit: () => void;
  /** 提交成功或显式放弃后的完整复位：字段、提交状态、错误与来源标记一并清理。 */
  clear: () => void;
};

/**
 * 新建草稿。seed 变化时重新初始化（Chat seed / 重新研究预填）；
 * seed 消失（如 Chat 来源状态被清除）时保留当前编辑值，
 * 保证同一次 Workspace 生命周期内未提交草稿不丢失。
 */
export function useResearchDraft(seed: ResearchDraftSeedInput | undefined): ResearchDraftController {
  const core = useResearchDraftCore(draftValuesFromSeed(seed));
  const { replaceValues } = core;
  const [fromChat, setFromChat] = useState(() => Boolean(seed?.fromChat));
  const seedRef = useRef(seed);

  useEffect(() => {
    if (seed === seedRef.current) return;
    seedRef.current = seed;
    if (seed) {
      replaceValues(draftValuesFromSeed(seed));
      setFromChat(Boolean(seed.fromChat));
    }
  }, [seed, replaceValues]);

  const clear = useCallback(() => {
    replaceValues(BLANK_DRAFT);
    setFromChat(false);
  }, [replaceValues]);

  return {
    ...core.values,
    submitting: core.submitting,
    error: core.error,
    fromChat,
    setQuestion: core.setQuestion,
    setExternalSearch: core.setExternalSearch,
    toggleKnowledgeBase: core.toggleKnowledgeBase,
    pruneKnowledgeBaseIds: core.pruneKnowledgeBaseIds,
    setError: core.setError,
    beginSubmit: core.beginSubmit,
    endSubmit: core.endSubmit,
    clear
  };
}

export type ResearchFollowUpDraftController = ResearchDraftCore & {
  parentTaskId: string;
  /** follow-up 深链进入时按父任务初始化；同一父任务重复进入保留当前草稿。 */
  syncFromParent: (task: ResearchTask) => void;
  reset: () => void;
};

/** follow-up 草稿：与新建草稿共享同一套字段与提交生命周期。 */
export function useResearchFollowUpDraft(): ResearchFollowUpDraftController {
  const core = useResearchDraftCore(BLANK_DRAFT);
  const { replaceValues } = core;
  const [parentTaskId, setParentTaskId] = useState('');

  const syncFromParent = useCallback((task: ResearchTask) => {
    if (parentTaskId === task.id) return;
    setParentTaskId(task.id);
    replaceValues({
      question: '',
      knowledgeBaseIds: [...task.knowledgeBaseIds],
      externalSearch: externalSearchFromSearchMode(task.searchMode)
    });
  }, [parentTaskId, replaceValues]);

  const reset = useCallback(() => {
    setParentTaskId('');
    replaceValues(BLANK_DRAFT);
  }, [replaceValues]);

  return {
    ...core,
    parentTaskId,
    syncFromParent,
    reset
  };
}
