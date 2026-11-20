import "../export/kit/kit.css";
import "./settings.css";
import type { RouteModule } from "../../app/services";
import { SettingsPage } from "./SettingsPage";

const route: RouteModule = { name: "settings", Component: SettingsPage, title: "Settings" };

export default route;
