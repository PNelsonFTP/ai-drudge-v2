// The "home" RouteModule (eager). Browser entry of the feature: it loads the stylesheets of the home
// page and of the headline row, so node tests import ./HomePage instead (node cannot load .css).

import "../headline/headline.css";
import "./home.css";
import type { RouteModule } from "../../app/services";
import { HomePage } from "./HomePage";

const route: RouteModule = {
  name: "home",
  Component: HomePage,
  title: "Top stories",
};

export default route;
