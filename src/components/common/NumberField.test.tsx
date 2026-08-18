import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NumberField } from './NumberField';

/** Mirrors how the properties panel wires it: value in, committed value out. */
function Harness({
  onChange,
  initial = 20,
}: {
  onChange?: (value: number) => void;
  initial?: number;
}) {
  const [value, setValue] = useState(initial);
  return (
    <NumberField
      label="W"
      value={value}
      unit="px"
      min={0}
      max={500}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const scrub = (
  label: HTMLElement,
  from: number,
  to: number,
  modifiers: Partial<PointerEventInit> = {}
) => {
  fireEvent.pointerDown(label, { clientX: from, button: 0 });
  fireEvent.pointerMove(window, { clientX: to, ...modifiers });
  fireEvent.pointerUp(window, { clientX: to });
};

describe('NumberField', () => {
  it('shows the value and its unit', () => {
    render(<Harness />);
    expect(screen.getByLabelText('W')).toHaveValue(20);
    expect(screen.getByText('px')).toBeInTheDocument();
  });

  describe('drag to scrub', () => {
    it('changes the value by one step per 2px of travel', () => {
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);

      // 40px right ÷ 2px-per-step × step 1 = +20.
      scrub(screen.getByText('W'), 100, 140);

      expect(onChange).toHaveBeenLastCalledWith(40);
      expect(screen.getByLabelText('W')).toHaveValue(40);
    });

    it('scrubs left as well as right', () => {
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);
      scrub(screen.getByText('W'), 100, 80);
      expect(onChange).toHaveBeenLastCalledWith(10);
    });

    it('coarsens by ten with Shift', () => {
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);
      scrub(screen.getByText('W'), 100, 110, { shiftKey: true });
      // 10px ÷ 2 = 5 steps, ×10 = +50.
      expect(onChange).toHaveBeenLastCalledWith(70);
    });

    it('refines by a tenth with Alt', () => {
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);
      scrub(screen.getByText('W'), 100, 120, { altKey: true });
      // 20px ÷ 2 = 10 steps, ×0.1 = +1.
      expect(onChange).toHaveBeenLastCalledWith(21);
    });

    it('clamps to min and max', () => {
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);
      scrub(screen.getByText('W'), 100, 2000);
      expect(onChange).toHaveBeenLastCalledWith(500);
    });

    it('brackets the drag with scrub callbacks so it can become one undo entry', () => {
      const onScrubStart = vi.fn();
      const onScrubEnd = vi.fn();
      render(
        <NumberField
          label="X"
          value={0}
          onChange={vi.fn()}
          onScrubStart={onScrubStart}
          onScrubEnd={onScrubEnd}
        />
      );

      const label = screen.getByText('X');
      fireEvent.pointerDown(label, { clientX: 0, button: 0 });
      expect(onScrubStart).toHaveBeenCalledTimes(1);
      expect(onScrubEnd).not.toHaveBeenCalled();

      fireEvent.pointerMove(window, { clientX: 30 });
      expect(onScrubEnd).not.toHaveBeenCalled();

      fireEvent.pointerUp(window, { clientX: 30 });
      expect(onScrubEnd).toHaveBeenCalledTimes(1);
    });

    /*
      `onScrubEnd` commits a history transaction, so "exactly once per gesture"
      is a correctness requirement, not tidiness: a second call closes whatever
      unrelated transaction is open by then, and a missing one leaves this
      drag's open forever - undo is refused while a transaction is open.
    */
    it('ends a scrub the field never saw finish, because it unmounted first', () => {
      const onScrubEnd = vi.fn();
      const view = render(
        <NumberField
          label="X"
          value={0}
          onChange={vi.fn()}
          onScrubStart={vi.fn()}
          onScrubEnd={onScrubEnd}
        />
      );

      fireEvent.pointerDown(screen.getByText('X'), { clientX: 0, button: 0 });
      fireEvent.pointerMove(window, { clientX: 30 });
      // The selection emptied under the held pointer and the panel swapped this
      // section out. No pointerup will ever reach it.
      view.unmount();

      expect(onScrubEnd).toHaveBeenCalledTimes(1);
    });

    it('does not end the same scrub twice', () => {
      const onScrubEnd = vi.fn();
      const view = render(
        <NumberField
          label="X"
          value={0}
          onChange={vi.fn()}
          onScrubStart={vi.fn()}
          onScrubEnd={onScrubEnd}
        />
      );

      const label = screen.getByText('X');
      fireEvent.pointerDown(label, { clientX: 0, button: 0 });
      fireEvent.pointerMove(window, { clientX: 30 });
      // pointercancel and pointerup both end the gesture, and both listeners are
      // still attached until the effect tears down - so a cancel the browser
      // follows with an up hits the same handler twice in one tick.
      fireEvent.pointerCancel(window, { clientX: 30 });
      fireEvent.pointerUp(window, { clientX: 30 });
      // And the teardown that follows is the third route into it.
      view.unmount();

      expect(onScrubEnd).toHaveBeenCalledTimes(1);
    });

    it('ignores non-primary buttons', () => {
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);
      fireEvent.pointerDown(screen.getByText('W'), { clientX: 100, button: 2 });
      fireEvent.pointerMove(window, { clientX: 200 });
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('typing', () => {
    it('does not emit a value per keystroke on the way to the intended one', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);

      const input = screen.getByLabelText('W');
      await user.clear(input);
      await user.type(input, '100');

      // "1" and "10" are stages of typing, not values the document should ever
      // have held - the whole point of the local draft.
      expect(onChange).not.toHaveBeenCalled();
      expect(input).toHaveValue(100);
    });

    it('commits on Enter', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);

      const input = screen.getByLabelText('W');
      await user.clear(input);
      await user.type(input, '100{Enter}');

      expect(onChange).toHaveBeenCalledExactlyOnceWith(100);
    });

    it('commits on blur', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);

      const input = screen.getByLabelText('W');
      await user.clear(input);
      await user.type(input, '64');
      await user.tab();

      expect(onChange).toHaveBeenCalledExactlyOnceWith(64);
    });

    it('reverts on Escape without committing', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);

      const input = screen.getByLabelText('W');
      await user.clear(input);
      await user.type(input, '999{Escape}');

      expect(onChange).not.toHaveBeenCalled();
      expect(input).toHaveValue(20);
    });

    it('reverts rather than writing NaN when the field is emptied', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);

      const input = screen.getByLabelText('W');
      await user.clear(input);
      await user.tab();

      expect(onChange).not.toHaveBeenCalled();
      expect(input).toHaveValue(20);
    });

    it('clamps a typed value into range', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);

      const input = screen.getByLabelText('W');
      await user.clear(input);
      await user.type(input, '9000{Enter}');

      expect(onChange).toHaveBeenCalledExactlyOnceWith(500);
    });
  });

  describe('keyboard nudging', () => {
    it('steps with the arrow keys, and by ten with Shift', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Harness onChange={onChange} />);

      const input = screen.getByLabelText('W');
      await user.click(input);
      await user.keyboard('{ArrowUp}');
      expect(onChange).toHaveBeenLastCalledWith(21);

      await user.keyboard('{ArrowDown}');
      expect(onChange).toHaveBeenLastCalledWith(20);

      await user.keyboard('{Shift>}{ArrowUp}{/Shift}');
      expect(onChange).toHaveBeenLastCalledWith(30);
    });
  });

  describe('mixed selections', () => {
    it('renders a placeholder and refuses to scrub', () => {
      const onChange = vi.fn();
      render(<NumberField label="H" value={null} onChange={onChange} />);

      const input = screen.getByLabelText('H');
      expect(input).toHaveValue(null);
      expect(input).toHaveAttribute('placeholder', 'Mixed');

      fireEvent.pointerDown(screen.getByText('H'), { clientX: 0, button: 0 });
      fireEvent.pointerMove(window, { clientX: 100 });
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
