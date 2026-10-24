import { createRoot } from "react-dom/client";

import { Console } from "./console.tsx";

const root = document.querySelector("#root");
if (root === null) throw new Error("Missing element: root");
createRoot(root).render(<Console />);
