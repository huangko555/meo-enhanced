type WorkspaceStateCleanupPort = {
  update(key: string, value: undefined): Thenable<void>;
};

const RETIRED_VIEW_POSITIONS_STATE_KEY = 'rememberedViewPositionsByDocument';

/** Removes the retired cross-session viewport payload without reading or restoring it. */
export async function cleanupRetiredWorkspaceState(workspaceState: WorkspaceStateCleanupPort): Promise<void> {
  try {
    await workspaceState.update(RETIRED_VIEW_POSITIONS_STATE_KEY, undefined);
  } catch {
    // Cleanup must not prevent extension activation; a later activation retries the idempotent deletion.
  }
}
