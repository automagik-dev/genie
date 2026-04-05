import { Settings } from '../../genie/ui/Settings';

export function SettingsView(props: { windowId: string; meta?: Record<string, unknown> }) {
  return <Settings {...props} />;
}
