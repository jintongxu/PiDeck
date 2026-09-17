import type { AppSettings } from "../../../../../shared/types/settings";
import { APP_UPDATE_RELEASES_URL } from "../../../../../shared/updateSources";
import { t } from "../../../i18n";
import { SettingRow } from "./SettingRows";

/** Read-only app source; do not mutate the preference used by independent assets. */
export function UpdateSourceSetting(_props: {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
}) {
  return (
    <SettingRow title={t("settings.updateSource")}
      description={t("settings.updateSourceFeedPreview", { url: APP_UPDATE_RELEASES_URL })}>
      <span className="text-sm">GitHub · jintongxu/PiDeck</span>
    </SettingRow>
  );
}
