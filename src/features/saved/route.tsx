import "../export/kit/kit.css";
import type { RouteModule } from "../../app/services";
import { savedTitle } from "./model";
import { SavedPage } from "./SavedPage";

const route: RouteModule = { name: "saved", Component: SavedPage, title: savedTitle };

export default route;
