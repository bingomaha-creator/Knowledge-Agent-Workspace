import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

const baseOptions = [
  { value: 'a', label: '选项 A' },
  { value: 'b', label: '选项 B' },
  { value: 'c', label: '禁用项 C', disabled: true }
];

function setup(overrides: Partial<Parameters<typeof Select>[0]> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <Select
      aria-label="选择项目"
      value="a"
      onChange={onChange}
      options={baseOptions}
      {...overrides}
    />
  );
  return { onChange, ...utils };
}

function openTrigger() {
  const trigger = screen.getByRole('combobox', { name: '选择项目' });
  fireEvent.click(trigger);
  return trigger;
}

describe('Select', () => {
  it('renders the committed value on a collapsed trigger', () => {
    setup();
    expect(screen.getByRole('combobox', { name: '选择项目' })).toHaveTextContent('选项 A');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens a listbox highlighting the committed value without calling onChange', () => {
    const { onChange } = setup();
    const trigger = openTrigger();

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox');
    expect(listbox).toHaveAttribute('id', trigger.getAttribute('aria-controls'));
    expect(screen.getByRole('option', { name: '选项 A' })).toHaveAttribute('aria-selected', 'true');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: '选项 A' }).getAttribute('id')
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('moves the active highlight with arrow keys, skips disabled options and does not commit', () => {
    const { onChange } = setup();
    const trigger = openTrigger();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: '选项 B' }).getAttribute('id')
    );
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    // 禁用项 C 被跳过，从 B 环绕回 A
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: '选项 A' }).getAttribute('id')
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits the highlighted option once with Enter and closes', () => {
    const { onChange } = setup();
    const trigger = openTrigger();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('cancels the uncommitted highlight with Escape and keeps the old value', () => {
    const { onChange } = setup();
    const trigger = openTrigger();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('选项 A');
  });

  it('stops Escape propagation while open so a dialog is not closed together', () => {
    const windowEscape = vi.fn();
    const listener = (event: KeyboardEvent) => windowEscape(event.key);
    window.addEventListener('keydown', listener);
    const { unmount } = setup();
    const trigger = openTrigger();

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(windowEscape).not.toHaveBeenCalled();

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(windowEscape).toHaveBeenCalledTimes(1);
    unmount();
    window.removeEventListener('keydown', listener);
  });

  it('closes on outside pointerdown without committing and without stealing focus', () => {
    const { onChange } = setup();
    const trigger = openTrigger();
    trigger.focus();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside click and lets the clicked control keep focus naturally', () => {
    const onChange = vi.fn();
    render(
      <div>
        <Select aria-label="选择项目" value="a" onChange={onChange} options={baseOptions} />
        <input aria-label="其他输入" />
      </div>
    );
    const trigger = screen.getByRole('combobox', { name: '选择项目' });
    fireEvent.click(trigger);
    const other = screen.getByRole('textbox', { name: '其他输入' });

    fireEvent.pointerDown(other);
    other.focus();

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(other);
  });

  it('closes on Tab without committing and moves focus to the next control', async () => {
    const onChange = vi.fn();
    render(
      <div>
        <input aria-label="上一个控件" />
        <Select aria-label="选择项目" value="a" onChange={onChange} options={baseOptions} />
        <input aria-label="下一个控件" />
      </div>
    );
    const trigger = screen.getByRole('combobox', { name: '选择项目' });
    fireEvent.click(trigger);
    // 真实浏览器中点击会聚焦按钮；fireEvent.click 不会，这里显式对齐
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    await userEvent.tab();

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '下一个控件' }));
  });

  it('moves focus to the previous control on Shift+Tab while open', async () => {
    const onChange = vi.fn();
    render(
      <div>
        <input aria-label="上一个控件" />
        <Select aria-label="选择项目" value="a" onChange={onChange} options={baseOptions} />
        <input aria-label="下一个控件" />
      </div>
    );
    const trigger = screen.getByRole('combobox', { name: '选择项目' });
    fireEvent.click(trigger);
    trigger.focus();

    await userEvent.tab({ shift: true });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '上一个控件' }));
  });

  it('expands again on the very next click after a keyboard confirm', () => {
    const { onChange } = setup();
    const trigger = openTrigger();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('resets the highlight to the committed value when reopened after cancel', () => {
    const { onChange } = setup();
    const trigger = openTrigger();

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Escape' });
    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: '选项 A' }).getAttribute('id')
    );
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('commits on option click and ignores disabled options', () => {
    const { onChange } = setup();
    openTrigger();

    fireEvent.click(screen.getByRole('option', { name: '禁用项 C' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: '选项 B' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('shows the placeholder when the value is not among the options', () => {
    setup({ value: 'missing', placeholder: '暂无项目' });
    expect(screen.getByRole('combobox', { name: '选择项目' })).toHaveTextContent('暂无项目');
  });

  it('keeps the re-clamped option active when options shrink and expand again', async () => {
    const onChange = vi.fn();
    function Dynamic() {
      const [options, setOptions] = useState(baseOptions);
      useEffect(() => {
        const shrinkTimer = window.setTimeout(() => setOptions([{ value: 'x', label: '新选项' }]), 30);
        const expandTimer = window.setTimeout(() => setOptions([
          { value: 'x', label: '新选项' },
          { value: 'y', label: '后加入选项' }
        ]), 60);
        return () => {
          window.clearTimeout(shrinkTimer);
          window.clearTimeout(expandTimer);
        };
      }, []);
      return <Select aria-label="选择项目" value="a" onChange={onChange} options={options} />;
    }
    render(<Dynamic />);
    const trigger = screen.getByRole('combobox', { name: '选择项目' });
    fireEvent.click(trigger);
    // 打开首帧即以已提交值初始化高亮。
    await waitFor(() => expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: '选项 A' }).getAttribute('id')
    ));
    // 再把活动高亮移动到将被删除的“选项 B”
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: '选项 B' }).getAttribute('id')
    );

    await waitFor(() => expect(screen.getByRole('option', { name: '新选项' })).toBeInTheDocument());
    // 列表更新后：已提交值不在新列表中，活动项恢复到第一个可用项，且引用不悬空
    const activeId = trigger.getAttribute('aria-activedescendant') ?? '';
    expect(activeId).toBe(screen.getByRole('option', { name: '新选项' }).getAttribute('id'));
    expect(document.getElementById(activeId)).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getByRole('option', { name: '后加入选项' })).toBeInTheDocument());
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: '新选项' }).getAttribute('id')
    );
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('x');
  });
});
