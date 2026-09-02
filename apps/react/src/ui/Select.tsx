import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react';
import { createPortal } from 'react-dom';
import styled from 'styled-components';

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  'aria-label'?: string;
  /** value 不在 options 中时触发器显示的占位文案（如“暂无项目”）。 */
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  /**
   * 弹层宿主：返回浮层挂载容器。默认挂到 body（普通页面）；
   * 弹窗场景应传 dialog 容器（如 () => dialogRef.current），
   * 使选项留在 aria-modal 语义范围内。
   */
  popupHost?: () => HTMLElement | null;
};

/** 触发器与浮层的间距规格：4–8px，取 6px。 */
const POPUP_GAP = 6;
const MAX_POPUP_HEIGHT = 288;
/** 两侧都放不下时的保底可视高度：允许覆盖，但不越出视口。 */
const MIN_POPUP_HEIGHT = 48;

type PopupPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

type PopupStyle = CSSProperties & {
  '--select-popup-top'?: string;
  '--select-popup-left'?: string;
  '--select-popup-width'?: string;
  '--select-popup-max-height'?: string;
};

const StyledTrigger = styled.button`
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  min-height: 2.5rem;
  padding: 0.4rem 2rem 0.4rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: var(--color-text);
  background: var(--color-surface);
  font-size: 0.875rem;
  text-align: left;

  &:hover:not(:disabled) { border-color: var(--color-primary-border); }

  &[aria-expanded='true'] { border-color: var(--color-primary-border); }
`;

const TriggerLabel = styled.span<{ $placeholder: boolean }>`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: ${({ $placeholder }) => ($placeholder ? 'var(--color-text-subtle)' : 'inherit')};
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 装饰性文本不拦截点击：命中目标始终是触发按钮本身。 */
  pointer-events: none;
`;

const Chevron = styled.span`
  position: absolute;
  top: 50%;
  right: 0.7rem;
  width: 0;
  height: 0;
  border-right: 4px solid transparent;
  border-left: 4px solid transparent;
  border-top: 5px solid var(--color-text-subtle);
  transform: translateY(-50%);
  pointer-events: none;
`;

const StyledPopup = styled.div`
  position: fixed;
  z-index: 60;
  top: var(--select-popup-top, -9999px);
  left: var(--select-popup-left, -9999px);
  width: var(--select-popup-width, auto);
  max-height: var(--select-popup-max-height, none);
  visibility: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  box-shadow: var(--shadow-soft);

  &[data-positioned='true'] { visibility: visible; }
`;

const StyledOption = styled.div<{ $active: boolean; $selected: boolean }>`
  padding: 0.45rem 0.6rem;
  border-radius: calc(var(--radius-control) / 2);
  color: ${({ $selected }) => ($selected ? 'var(--color-primary)' : 'var(--color-text)')};
  font-size: 0.875rem;
  font-weight: ${({ $selected }) => ($selected ? 650 : 400)};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;

  &[aria-disabled='true'] {
    color: var(--color-text-subtle);
    cursor: not-allowed;
  }

  ${({ $active }) => ($active ? 'background: var(--color-primary-surface);' : '')}
`;

const EmptyHint = styled.div`
  padding: 0.45rem 0.6rem;
  color: var(--color-text-subtle);
  font-size: 0.875rem;
`;

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    value,
    onChange,
    options,
    'aria-label': ariaLabel,
    placeholder,
    disabled,
    autoFocus,
    className,
    popupHost
  },
  ref
) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const activeOptionRef = useRef<HTMLDivElement>(null);
  const popupHostRef = useRef(popupHost);
  popupHostRef.current = popupHost;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [popupPosition, setPopupPosition] = useState<PopupPosition | null>(null);
  const listboxId = useId();

  const enabledIndexes = useMemo(
    () => options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0),
    [options]
  );
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : undefined;
  const hasValue = selectedIndex >= 0;

  // 渲染期派生：活动索引失效（越界或被禁用，如选项列表收缩的那一帧）时立即回退到
  // 已提交值或第一个可用项，保证 aria-activedescendant 永不指向不存在的选项。
  const resolvedActiveIndex = (() => {
    if (activeIndex >= 0 && activeIndex < options.length && !options[activeIndex]?.disabled) {
      return activeIndex;
    }
    const byValue = selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : -1;
    return byValue >= 0 ? byValue : enabledIndexes[0] ?? -1;
  })();

  const initialActiveIndex = selectedIndex >= 0 && !options[selectedIndex]?.disabled
    ? selectedIndex
    : enabledIndexes[0] ?? -1;

  const firstEnabledIndex = useCallback(
    () => (enabledIndexes.length ? enabledIndexes[0] : -1),
    [enabledIndexes]
  );
  const lastEnabledIndex = useCallback(
    () => (enabledIndexes.length ? enabledIndexes[enabledIndexes.length - 1] : -1),
    [enabledIndexes]
  );

  const positionPopup = useCallback(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    const rect = trigger.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const desired = Math.min(MAX_POPUP_HEIGHT, Math.max(popup.scrollHeight, 36));
    const spaceBelow = viewportHeight - rect.bottom - POPUP_GAP;
    const spaceAbove = rect.top - POPUP_GAP;
    let top: number;
    let maxHeight: number;
    if (desired <= spaceBelow) {
      top = rect.bottom + POPUP_GAP;
      maxHeight = desired;
    } else if (desired <= spaceAbove) {
      top = rect.top - POPUP_GAP - desired;
      maxHeight = desired;
    } else if (spaceBelow >= spaceAbove) {
      // 两侧都放不下：取较大的一侧，位置与高度夹取进可视区域（允许覆盖，但不越出视口）。
      top = Math.min(
        Math.max(rect.bottom + POPUP_GAP, POPUP_GAP),
        Math.max(viewportHeight - POPUP_GAP - MIN_POPUP_HEIGHT, POPUP_GAP)
      );
      maxHeight = Math.max(viewportHeight - top - POPUP_GAP, MIN_POPUP_HEIGHT);
    } else {
      maxHeight = Math.max(Math.min(spaceAbove, viewportHeight - 2 * POPUP_GAP), MIN_POPUP_HEIGHT);
      top = Math.max(
        POPUP_GAP,
        Math.min(rect.top - POPUP_GAP - maxHeight, viewportHeight - POPUP_GAP - MIN_POPUP_HEIGHT)
      );
    }
    // 所有分支计算完成后统一夹取：浮层不越出视口（覆盖触发器随容器滚动到视口外的场景），
    // 保底高度也不突破夹取后的实际可用空间。
    top = Math.min(
      Math.max(top, POPUP_GAP),
      Math.max(viewportHeight - POPUP_GAP - MIN_POPUP_HEIGHT, POPUP_GAP)
    );
    maxHeight = Math.min(maxHeight, Math.max(viewportHeight - top - POPUP_GAP, 0));
    setPopupPosition({ top, left: rect.left, width: rect.width, maxHeight });
  }, []);

  // 打开：先渲染浮层（不可见），在绘制前完成定位测量，避免闪跳。
  useLayoutEffect(() => {
    if (!open) return;
    positionPopup();
  }, [open, positionPopup]);

  // 展开期间跟随滚动（capture：scroll 不冒泡）与视口变化重新定位。
  useEffect(() => {
    if (!open) return;
    const reposition = () => positionPopup();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      // 点击外部：关闭但不提交未确认高亮，也不把焦点抢回触发器。
      setOpen(false);
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, positionPopup]);

  // 选项变化导致活动索引失效时，渲染期先用 resolved 值避免悬空引用，
  // 再在绘制前同步回唯一状态，防止旧索引在列表重新扩展后复活。
  useLayoutEffect(() => {
    if (open && activeIndex !== resolvedActiveIndex) setActiveIndex(resolvedActiveIndex);
  }, [activeIndex, open, resolvedActiveIndex]);

  // 高亮项变化后滚入浮层可见区。
  useEffect(() => {
    const option = activeOptionRef.current;
    if (open && option && typeof option.scrollIntoView === 'function') {
      option.scrollIntoView({ block: 'nearest' });
    }
  }, [resolvedActiveIndex, open]);

  function commit(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    setOpen(false);
  }

  function moveActive(step: 1 | -1) {
    if (!enabledIndexes.length) return;
    const positions = enabledIndexes;
    const position = positions.indexOf(resolvedActiveIndex);
    const next = position === -1
      ? (step === 1 ? positions[0] : positions[positions.length - 1])
      : positions[(position + step + positions.length) % positions.length];
    setActiveIndex(next);
  }

  function openPopup() {
    // 打开前同步初始化，首帧就以已提交值或第一个可用项作为活动项。
    setActiveIndex(initialActiveIndex);
    setOpen(true);
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!open) {
          openPopup();
          return;
        }
        moveActive(event.key === 'ArrowDown' ? 1 : -1);
        break;
      }
      case 'Home': {
        if (!open) return;
        event.preventDefault();
        setActiveIndex(firstEnabledIndex());
        break;
      }
      case 'End': {
        if (!open) return;
        event.preventDefault();
        setActiveIndex(lastEnabledIndex());
        break;
      }
      case 'Enter':
      case ' ': {
        if (!open) return;
        // preventDefault 同时取消 button 的默认激活（Enter 的 keydown click / Space 的 keyup click），
        // 因此不存在需要吞掉的默认 click，不会影响下一次真实点击。
        event.preventDefault();
        commit(resolvedActiveIndex);
        break;
      }
      case 'Escape': {
        if (!open) return;
        // 第一段 Escape 只关闭下拉：阻止冒泡，避免弹窗的全局 Escape 处理连表单一起关闭。
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        break;
      }
      case 'Tab': {
        // Tab 关闭但不提交，焦点按正常顺序继续移动（弹窗内由焦点陷阱接管循环）。
        if (open) setOpen(false);
        break;
      }
      default:
        break;
    }
  }

  function onTriggerClick() {
    if (disabled) return;
    // 再次点击触发器：关闭并放弃未确认高亮（value 不变）。
    if (open) setOpen(false);
    else openPopup();
  }

  const popupContainer = popupHostRef.current?.() ?? document.body;
  const activeDescendantId =
    open && resolvedActiveIndex >= 0 ? `${listboxId}-option-${resolvedActiveIndex}` : undefined;
  const popupStyle: PopupStyle | undefined = popupPosition
    ? {
        '--select-popup-top': `${popupPosition.top}px`,
        '--select-popup-left': `${popupPosition.left}px`,
        '--select-popup-width': `${popupPosition.width}px`,
        '--select-popup-max-height': `${popupPosition.maxHeight}px`
      }
    : undefined;

  return (
    <>
      <StyledTrigger
        ref={(node) => {
          triggerRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        type="button"
        className={className}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeDescendantId}
        aria-label={ariaLabel}
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKeyDown}
      >
        <TriggerLabel $placeholder={!hasValue && Boolean(placeholder)}>
          {hasValue ? selectedLabel : placeholder ?? value}
        </TriggerLabel>
        <Chevron aria-hidden="true" />
      </StyledTrigger>
      {open
        ? createPortal(
            <StyledPopup
              ref={popupRef}
              id={listboxId}
              role="listbox"
              data-positioned={Boolean(popupPosition)}
              style={popupStyle}
            >
              {options.length === 0 ? (
                <EmptyHint>暂无可选项</EmptyHint>
              ) : (
                options.map((option, index) => (
                  <StyledOption
                    key={option.value}
                    ref={index === resolvedActiveIndex ? activeOptionRef : undefined}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={option.value === value}
                    aria-disabled={option.disabled || undefined}
                    $active={index === resolvedActiveIndex}
                    $selected={option.value === value}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => commit(index)}
                  >
                    {option.label}
                  </StyledOption>
                ))
              )}
            </StyledPopup>,
            popupContainer
          )
        : null}
    </>
  );
});
