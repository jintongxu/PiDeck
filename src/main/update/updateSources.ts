/** App updates only use GitHub. Preserve legacy settings for independent assets. */
import type { UpdateSourceId } from "../../shared/types/settings";
export { normalizeCustomMirrorHost } from "../../shared/updateSources";
export function normalizeUpdateSource(_source: unknown): UpdateSourceId { return "github"; }
export type UpdateSourceOption = {
  id: UpdateSourceId; labelKey: string; host: string | null; feedUrl: string | null;
};
export function updateSourceOptions(): UpdateSourceOption[] {
  return [{ id: "github", labelKey: "github", host: null, feedUrl: null }];
}
/** null selects the pinned GitHub provider, never packaged YAML defaults. */
export function updateSourceFeedUrl(_source: UpdateSourceId, _customHost?: string | null): string | null { return null; }
export function updateSourceLatestReleaseUrl(_source: UpdateSourceId, _customHost?: string | null): string | null { return null; }
