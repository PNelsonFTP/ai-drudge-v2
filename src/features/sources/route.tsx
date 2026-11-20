import "../export/kit/kit.css";
import "./sources.css";
import type { RouteModule } from "../../app/services";
import { SourcesPage } from "./SourcesPage";

const route: RouteModule = { name: "sources", Component: SourcesPage, title: "Sources" };

export default route;
