import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { Tooltip } from './Tooltip';

/**
 * Real timers, short delays.
 *
 * Fake timers are the obvious tool here and the wrong one: user-event awaits a
 * real macrotask between every synthetic event, so faking the clock deadlocks
 * the interaction before the tooltip is even reached. Driving the component
 * with a small `delay` and sleeping for real keeps the test honest about the
 * thing being tested - that *time* gates the tooltip - at a cost of a couple of
 * seconds across the file.
 */
const DELAY_MS = 60;
/** Must exceed SKIP_DELAY_MS in Tooltip.tsx. */
const SKIP_WINDOW_LAPSE_MS = 340;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Tooltip', () => {
  // `lastClosedAt` is module state shared by every trigger - that's the point
  // of it. Each test starts outside the skip window so it can't inherit one.
  beforeEach(async () => {
    await sleep(SKIP_WINDOW_LAPSE_MS);
  });

  it('stays hidden until the open delay has elapsed', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Rectangle" delay={DELAY_MS}>
        <button type="button">R</button>
      </Tooltip>
    );

    await user.hover(screen.getByRole('button', { name: 'R' }));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent('Rectangle');
    });
  });

  it('cancels the pending tooltip when the pointer leaves first', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Ellipse" delay={DELAY_MS}>
        <button type="button">E</button>
      </Tooltip>
    );

    const trigger = screen.getByRole('button', { name: 'E' });
    await user.hover(trigger);
    await user.unhover(trigger);
    await sleep(DELAY_MS * 3);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('opens instantly on the next trigger while the skip window is still open', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tooltip label="Rectangle" delay={DELAY_MS}>
          <button type="button">R</button>
        </Tooltip>
        <Tooltip label="Ellipse" delay={DELAY_MS}>
          <button type="button">E</button>
        </Tooltip>
      </>
    );

    const rectangle = screen.getByRole('button', { name: 'R' });
    const ellipse = screen.getByRole('button', { name: 'E' });

    await user.hover(rectangle);
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent('Rectangle');
    });

    await user.unhover(rectangle);
    await user.hover(ellipse);

    // No sleep: sweeping across adjacent toolbar buttons must not re-serve the
    // delay, so the second tooltip is already in the DOM synchronously.
    expect(screen.getByRole('tooltip')).toHaveTextContent('Ellipse');
  });

  it('serves the full delay again once the skip window has lapsed', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Rectangle" delay={DELAY_MS}>
        <button type="button">R</button>
      </Tooltip>
    );

    const trigger = screen.getByRole('button', { name: 'R' });
    await user.hover(trigger);
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    });

    await user.unhover(trigger);
    await sleep(SKIP_WINDOW_LAPSE_MS);

    await user.hover(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('opens on keyboard focus and closes on blur', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before</button>
        <Tooltip label="Rectangle" delay={DELAY_MS}>
          <button type="button">R</button>
        </Tooltip>
      </>
    );

    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();

    expect(screen.getByRole('button', { name: 'R' })).toHaveFocus();
    // Keyboard focus skips the delay: a tab-through shouldn't feel laggy.
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    await user.tab();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('stays quiet when focus arrives from a click rather than the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Rectangle" delay={DELAY_MS}>
        <button type="button">R</button>
      </Tooltip>
    );

    await user.click(screen.getByRole('button', { name: 'R' }));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('renders the shortcut as keycaps beside the label', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Undo" shortcut="mod+z" delay={DELAY_MS}>
        <button type="button">U</button>
      </Tooltip>
    );

    await user.hover(screen.getByRole('button', { name: 'U' }));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Undo');
    // `mod` resolves per platform; jsdom's UA is not a Mac, so it renders Ctrl.
    expect(tooltip).toHaveTextContent('Ctrl');
    expect(tooltip).toHaveTextContent('Z');
  });

  it('closes on Escape without waiting for the pointer to leave', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Rectangle" delay={DELAY_MS}>
        <button type="button">R</button>
      </Tooltip>
    );

    await user.hover(screen.getByRole('button', { name: 'R' }));
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('never opens when disabled', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Rectangle" delay={DELAY_MS} disabled>
        <button type="button">R</button>
      </Tooltip>
    );

    await user.hover(screen.getByRole('button', { name: 'R' }));
    await sleep(DELAY_MS * 4);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('does not steal focus - the trigger keeps it while the tooltip is open', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Rectangle" delay={DELAY_MS}>
        <button type="button">R</button>
      </Tooltip>
    );

    const trigger = screen.getByRole('button', { name: 'R' });
    trigger.focus();
    await user.hover(trigger);
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    });

    expect(trigger).toHaveFocus();
  });
});
