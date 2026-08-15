import { create } from "zustand";

interface UiState {
  selectedRunId: string | null;
  compareBranchIds: string[];
  inspectorTab: "config" | "run" | "evidence";
  setSelectedRunId(value: string | null): void;
  setCompareBranchIds(value: string[]): void;
  setInspectorTab(value: UiState["inspectorTab"]): void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedRunId: null,
  compareBranchIds: [],
  inspectorTab: "config",
  setSelectedRunId: (selectedRunId) => set({ selectedRunId, inspectorTab: "run" }),
  setCompareBranchIds: (compareBranchIds) => set({ compareBranchIds }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab })
}));
