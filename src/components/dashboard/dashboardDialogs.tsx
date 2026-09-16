// The project list's three dialogs are each rendered only while their flag in
// `model.dialogs` is set. Importing them statically put settings (provider
// catalogs and vendor icons), media cleanup
// into the entry chunk, so every cold start paid for screens most sessions
// never open. They load on demand and warm on idle through
// useDashboardDialogPrefetch (dashboardDialogLoaders.ts) instead — the same
// treatment the editor's overlays get in src/editor/workspaceDialogs.tsx.
import { lazy } from 'react';
import {
  loadMediaCleanupDialog, loadShortcutsDialog,
} from './dashboardDialogLoaders';

export const ShortcutsDialog = lazy(() => loadShortcutsDialog().then((m) => ({ default: m.ShortcutsDialog })));
export const MediaCleanupDialog = lazy(() => loadMediaCleanupDialog().then((m) => ({ default: m.MediaCleanupDialog })));
