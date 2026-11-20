import "../export/kit/kit.css";
import "./about.css";
import type { RouteModule } from "../../app/services";
import { AboutPage } from "./AboutPage";

const route: RouteModule = { name: "about", Component: AboutPage, title: "About" };

export default route;
