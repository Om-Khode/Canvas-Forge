import { useMemo, useState } from 'react';
import { Button, Dialog, SegmentedControl, Select, TextField, Toggle } from '@/components/common';
import { getExportFormat, type ExportFormat, type ExportScope } from '@/features/commands';
import { getCanvasTheme } from '@/features/canvas/engine/theme';
import { downloadBlob, downloadText } from '@/features/export/download';
import {
  exportProjectJson,
  jsonFilename,
  JSON_EXPORT_EXTENSION,
  JSON_EXPORT_MIME,
} from '@/features/export/json';
import { exportPng, planPngExportFor, PNG_SCALES } from '@/features/export/png';
import { exportSubject } from '@/features/export/scope';
import { elementsToSvg } from '@/features/export/svg';
import { projectSession } from '@/features/project/useProjectSession';
import { contentBounds } from '@/features/selection/bounds';
import { imageStore } from '@/services/imageStore';
import { useCanvasStore } from '@/store';
import type { CanvasElement, Project } from '@/types';

/**
 * Export.
 *
 * The dialog owns *options*, not export logic: PNG goes through
 * `features/export/png`, SVG through `features/export/svg`, JSON through
 * `features/export/json`. What it adds is the part that only makes sense with a
 * user in front of it - a live dimension estimate before the click, and a
 * visible error afterwards. An export that silently does nothing is the single
 * most common way this feature is shipped broken.
 */

const SVG_MIME = 'image/svg+xml';
/** Mirrors the SVG serializer's own default padding, which it does not export. */
const SVG_PADDING = 24;
const EXTENSIONS: Readonly<Record<ExportFormat, string>> = {
  png: '.png',
  svg: '.svg',
  json: JSON_EXPORT_EXTENSION,
};

/**
 * SVG and JSON inline their images as data URIs so the file is self-contained.
 * The blobs live in IndexedDB keyed by content, so this is a read per *distinct*
 * key rather than per element.
 */
async function collectImages(
  elements: readonly CanvasElement[]
): Promise<Readonly<Record<string, string>>> {
  const images: Record<string, string> = {};
  for (const element of elements) {
    if (element.type !== 'image' || images[element.imageKey] !== undefined) continue;
    const read = await imageStore.getImageBlob(element.imageKey);
    if (!read.ok) continue;
    const blob = read.value;
    if (blob === null) continue;
    images[element.imageKey] = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(typeof reader.result === 'string' ? reader.result : '');
      };
      // A key that cannot be read exports as a placeholder rather than failing
      // the whole file - the SVG serializer already draws one.
      reader.onerror = () => {
        resolve('');
      };
      reader.readAsDataURL(blob);
    });
  }
  return images;
}

function withExtension(name: string, extension: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return `canvasforge-project${extension}`;
  return trimmed.endsWith(extension) ? trimmed : `${trimmed}${extension}`;
}

export function ExportDialog() {
  const open = useCanvasStore((state) => state.activeDialog === 'export');
  const closeDialog = useCanvasStore((state) => state.closeDialog);
  const projectName = useCanvasStore((state) => state.projectName);
  const elementStore = useCanvasStore((state) => state.elements);
  const selection = useCanvasStore((state) => state.selection);

  const [format, setFormat] = useState<ExportFormat>(getExportFormat);
  const [scope, setScope] = useState<ExportScope>('document');
  const [scale, setScale] = useState<string>('2');
  const [withBackground, setWithBackground] = useState(true);
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Re-read on every open, adjusting state during render rather than in an
   * effect. The dialog stays mounted between openings for its exit animation,
   * so without this it would keep the previous session's format and filename -
   * and the palette's "Export PNG…" entry, which sets the format immediately
   * before opening, would appear to be ignored.
   */
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setFormat(getExportFormat());
      setError(null);
      setFilename('');
      if (selection.size === 0) setScope('document');
    }
  }

  // Two shapes of the same subject, because PNG and SVG/JSON consume different
  // things - see `exportSubject`. `paint` is also what the estimate and the
  // "nothing to export" guard read, since it is the one that answers "does this
  // actually put ink on the page".
  const subject = useMemo(
    () => exportSubject(elementStore, scope === 'selection' ? selection : null),
    [elementStore, scope, selection]
  );
  const elements = subject.paint;

  const numericScale = Number(scale);
  const plan = useMemo(
    () => (format === 'png' ? planPngExportFor(elements, { scale: numericScale }) : null),
    [format, elements, numericScale]
  );
  const bounds = useMemo(() => contentBounds(elements), [elements]);
  // `elements.length` alone is not "will this actually produce a file": a
  // visible group whose every member is hidden leaves `elements = [group]`
  // (`contentBounds`/`planPngExportFor` both skip groups themselves, so the
  // length check saw a non-empty array while the box behind it was empty).
  // JSON is exempt - it serializes the whole selected subtree regardless of
  // what paints, so a hidden document is still a legitimate file to save.
  const nothingToExport =
    elements.length === 0 || (format !== 'json' && bounds === null);

  const estimate = (): string => {
    if (nothingToExport) return 'Nothing to export';
    if (format === 'json') return `${elements.length} element${elements.length === 1 ? '' : 's'}`;
    if (format === 'svg' && bounds !== null) {
      const pad = SVG_PADDING * 2;
      return `${Math.round(bounds.width + pad)} × ${Math.round(bounds.height + pad)} units`;
    }
    if (plan === null) return '-';
    // The clamp is surfaced *before* the click, because an export that silently
    // came out at 1.4× instead of 3× is a bug the user only finds much later.
    const clamped = plan.clamped
      ? ` · reduced to ${plan.scale.toFixed(2)}× to stay inside the browser's canvas limit`
      : '';
    return `${plan.widthPx} × ${plan.heightPx} px${clamped}`;
  };

  const runExport = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const name = withExtension(
        filename.length > 0 ? filename : jsonFilename(projectName, ''),
        EXTENSIONS[format]
      );
      const background = withBackground ? getCanvasTheme().background : null;

      if (format === 'png') {
        const result = await exportPng({ elements, scale: numericScale, background });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        const failure = downloadBlob(result.value.blob, name);
        if (failure !== null) {
          setError(failure.message);
          return;
        }
      } else if (format === 'svg') {
        // The pool, not the paint list: the serializer rebuilds the tree and
        // applies group opacity and `visible` itself. Images are still collected
        // from the paint list - those are exactly the ones that will be drawn,
        // so a hidden image's data URI never bloats the file.
        const svg = elementsToSvg(subject.pool, {
          background,
          images: await collectImages(elements),
        });
        const failure = downloadText(svg, name, SVG_MIME);
        if (failure !== null) {
          setError(failure.message);
          return;
        }
      } else {
        const snapshot = projectSession.snapshot();
        const scoped: Project =
          scope === 'selection'
            ? {
                ...snapshot,
                elements: {
                  // The pool again, and `rootIds` rather than every id: the
                  // serializer nests a group's members under it, so listing a
                  // member at the root too would describe two different trees.
                  byId: Object.fromEntries(subject.pool.map((element) => [element.id, element])),
                  order: subject.rootIds,
                },
              }
            : snapshot;
        const json = exportProjectJson(scoped, await collectImages(elements));
        if (!json.ok) {
          setError(json.error.message);
          return;
        }
        const failure = downloadText(json.value, name, JSON_EXPORT_MIME);
        if (failure !== null) {
          setError(failure.message);
          return;
        }
      }
      closeDialog();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      title="Export"
      description="Everything is produced locally - nothing is uploaded."
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={nothingToExport}
            onClick={() => {
              void runExport();
            }}
          >
            Export
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <SegmentedControl
          label="Scope"
          value={scope}
          onChange={setScope}
          fullWidth
          options={[
            { value: 'document', label: 'Whole document' },
            { value: 'selection', label: 'Selection', disabled: selection.size === 0 },
          ]}
        />

        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Format"
            value={format}
            onChange={setFormat}
            options={[
              { value: 'png', label: 'PNG image' },
              { value: 'svg', label: 'SVG vector' },
              { value: 'json', label: 'JSON project' },
            ]}
          />
          {format === 'png' && (
            <Select
              label="Scale"
              value={scale}
              onChange={setScale}
              options={PNG_SCALES.map((value) => ({ value: String(value), label: `${value}×` }))}
            />
          )}
        </div>

        <TextField
          label="File name"
          value={filename}
          onChange={setFilename}
          placeholder={withExtension(jsonFilename(projectName, ''), EXTENSIONS[format])}
          hint={estimate()}
        />

        {format !== 'json' && (
          <Toggle
            label="Background"
            description="Off exports with a transparent background."
            checked={withBackground}
            onChange={setWithBackground}
          />
        )}

        {error !== null && (
          <p role="alert" className="text-danger text-[0.8125rem] leading-snug">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
