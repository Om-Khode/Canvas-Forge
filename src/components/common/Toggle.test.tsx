import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Toggle } from './Toggle';

function Harness({ onChange }: { onChange?: (checked: boolean) => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <Toggle
      label="Snap to grid"
      description="Align new shapes to the background grid."
      checked={checked}
      onChange={(next) => {
        setChecked(next);
        onChange?.(next);
      }}
    />
  );
}

describe('Toggle', () => {
  it('exposes switch semantics with its label and description', () => {
    render(<Harness />);
    const toggle = screen.getByRole('switch', { name: 'Snap to grid' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAccessibleDescription('Align new shapes to the background grid.');
  });

  it('is reachable by Tab and toggles on Space', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.tab();
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveFocus();

    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('toggles on Enter as well', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    screen.getByRole('switch').focus();
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('toggles back off on a second activation', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = screen.getByRole('switch');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('is neither focusable nor operable when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle label="Locked" checked={false} onChange={onChange} disabled />);

    const toggle = screen.getByRole('switch', { name: 'Locked' });
    expect(toggle).toBeDisabled();

    await user.tab();
    expect(toggle).not.toHaveFocus();

    await user.keyboard(' ');
    expect(onChange).not.toHaveBeenCalled();
  });
});
