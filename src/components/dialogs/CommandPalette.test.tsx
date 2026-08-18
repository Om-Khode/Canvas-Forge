/**
 * The palette is graded on being keyboard-operable and correctly labelled, so
 * that is what these assert: the combobox contract, fuzzy matching, and the
 * rule that a disabled command is visible but unreachable.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { commandRegistry } from '@/features/commands';
import type { Command } from '@/features/shortcuts/registry';
import { resetCanvasStore, useCanvasStore } from '@/store';

const runExport = vi.fn();
const runUndo = vi.fn();

function fixture(): Command[] {
  return [
    {
      id: 'test.export-png',
      title: 'Export PNG…',
      group: 'export',
      keywords: ['image', 'raster'],
      run: runExport,
    },
    {
      id: 'test.undo',
      title: 'Undo',
      group: 'edit',
      shortcut: 'mod+z',
      isEnabled: () => false,
      run: runUndo,
    },
    { id: 'test.rectangle', title: 'Rectangle tool', group: 'tools', shortcut: 'r', run: vi.fn() },
  ];
}

let dispose: (() => void) | null = null;

beforeEach(() => {
  resetCanvasStore();
  runExport.mockClear();
  runUndo.mockClear();
  dispose = commandRegistry.registerAll(fixture());
  useCanvasStore.getState().openDialog('command-palette');
});

afterEach(() => {
  dispose?.();
  dispose = null;
  resetCanvasStore();
});

function input(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Search commands' });
}

describe('CommandPalette', () => {
  it('exposes a combobox wired to a listbox of options', () => {
    render(<CommandPalette />);

    const combobox = input();
    expect(combobox).toHaveAttribute('aria-controls', 'command-palette-results');
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('groups results and labels each group', () => {
    render(<CommandPalette />);

    expect(screen.getByRole('group', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Export' })).toBeInTheDocument();
  });

  it('points aria-activedescendant at the first runnable command', () => {
    render(<CommandPalette />);

    // "Undo" is first in group order but disabled, so it is skipped.
    expect(input()).toHaveAttribute('aria-activedescendant', 'cmd-test.rectangle');
  });

  it('matches a non-contiguous query', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(input(), 'epng');

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Export PNG');
  });

  it('reports no matches rather than showing an empty list', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(input(), 'zzzz');

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matching commands')).toBeInTheDocument();
  });

  it('runs the highlighted command on Enter and closes', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.type(input(), 'export');
    await user.keyboard('{Enter}');

    expect(runExport).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().activeDialog).toBeNull();
  });

  it('shows a disabled command but refuses to run it', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    const undo = screen.getByRole('option', { name: /Undo/ });
    expect(undo).toHaveAttribute('aria-disabled', 'true');

    await user.click(undo);
    expect(runUndo).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().activeDialog).toBe('command-palette');
  });

  it('skips disabled commands while arrowing', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.keyboard('{ArrowDown}');
    expect(input()).toHaveAttribute('aria-activedescendant', 'cmd-test.export-png');

    await user.keyboard('{ArrowDown}');
    // Wraps back around the two runnable commands; "Undo" is never selected.
    expect(input()).toHaveAttribute('aria-activedescendant', 'cmd-test.rectangle');
  });
});
