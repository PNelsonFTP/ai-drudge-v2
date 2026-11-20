import "../export/kit/kit.css";
import type { RouteModule } from "../../app/services";
import { NewPage } from "./NewPage";

const route: RouteModule = { name: "new", Component: NewPage, title: "New since your last visit" };

export default route;
