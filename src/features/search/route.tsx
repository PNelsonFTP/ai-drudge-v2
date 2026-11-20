import "../export/kit/kit.css";
import type { RouteModule } from "../../app/services";
import { searchTitle } from "./model";
import { SearchPage } from "./SearchPage";

const route: RouteModule = { name: "search", Component: SearchPage, title: searchTitle };

export default route;
