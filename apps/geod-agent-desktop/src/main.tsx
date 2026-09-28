import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
