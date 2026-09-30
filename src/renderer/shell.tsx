import { useState } from "react";
import { Board } from "./board-view";
import { createAppSource } from "./app-source";

export function Shell() {
  const [source] = useState(createAppSource);
  return <Board source={source} />;
}
