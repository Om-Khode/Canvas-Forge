import { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

/**
 * A dialog opened from a trigger - the only configuration where focus
 * restoration means anything, so the tests use it rather than rendering the
 * dialog already open.
 */
function Harness({ closeOnBackdropClick = true }: { closeOnBackdropClick?: boolean }) {
  const [open, setOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open export
      </button>
      <button type="button">Outside control</button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="Export image"
        description="Choose a format and scale."
        closeOnBackdropClick={closeOnBackdropClick}
        footer={<button type="button">Export</button>}
      >
        <input ref={nameRef} aria-label="File name" />
        <button type="button">Reset</button>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('is labelled by its title and described by its description', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open export' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Export image');
    expect(dialog).toHaveAccessibleDescription('Choose a format and scale.');
  });

  it('moves focus into the dialog on open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open export' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    });
  });

  it('cycles Tab within the dialog and never reaches the page behind it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open export' }));

    const fileName = screen.getByLabelText('File name');
    const reset = screen.getByRole('button', { name: 'Reset' });
    const exportButton = screen.getByRole('button', { name: 'Export' });
    const close = screen.getByRole('button', { name: 'Close' });

    // Close is the first focusable in DOM order, so that's where focus lands.
    await waitFor(() => {
      expect(close).toHaveFocus();
    });

    await user.tab();
    expect(fileName).toHaveFocus();
    await user.tab();
    expect(reset).toHaveFocus();
    await user.tab();
    expect(exportButton).toHaveFocus();

    // Past the last one, focus wraps back to the top rather than escaping to
    // the trigger sitting behind the scrim.
    await user.tab();
    expect(close).toHaveFocus();

    await user.tab({ shift: true });
    expect(exportButton).toHaveFocus();
  });

  it('closes on Escape and restores focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open export' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('closes on the close button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open export' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('locks body scroll while open and releases it on close', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open export' }));
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.body.style.overflow).toBe('');
    });
  });

  it('leaves the dialog open when the backdrop is disabled as a dismiss target', async () => {
    const user = userEvent.setup();
    render(<Harness closeOnBackdropClick={false} />);
    await user.click(screen.getByRole('button', { name: 'Open export' }));

    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not render anything while closed', () => {
    const onClose = vi.fn();
    render(
      <Dialog open={false} onClose={onClose} title="Never shown">
        <p>Body</p>
      </Dialog>
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
