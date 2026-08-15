import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { initializeLaunchToken } from "./api.js";
import { OperatorDialogProvider } from "./components/operator-dialog.js";
import { router } from "./router.js";
import { initializeUiPreferences } from "./ui-preferences.js";
import "@xyflow/react/dist/style.css";
import "./styles.css";

initializeLaunchToken();
initializeUiPreferences();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 1_000, refetchOnWindowFocus: false },
    mutations: { retry: false }
  }
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <OperatorDialogProvider>
        <RouterProvider router={router} />
      </OperatorDialogProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
