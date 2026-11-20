import "../export/kit/kit.css";
import type { RouteModule } from "../../app/services";
import { sectionTitle } from "./model";
import { SectionPage } from "./SectionPage";

const route: RouteModule = { name: "section", Component: SectionPage, title: sectionTitle };

export default route;
