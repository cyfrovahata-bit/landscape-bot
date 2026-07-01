// src/bot/flows/roadTimesheet.guards.ts
import type { State } from "./roadTimesheet.types.js";

export function canStartDay(st: State) {
  return (
    !!st.carId &&
    st.odoStartKm !== undefined &&
    st.odoStartPhotoFileId !== undefined &&
    st.plannedObjectIds.length >= 1 &&
    st.inCarIds.length > 0 &&
    st.phase === "SETUP"
  );
}

export function canDrive(st: State) {
  return st.phase === "DRIVE_DAY" && st.driveActive;
}

export function canPause(st: State) {
  return st.phase === "DRIVE_DAY" && st.driveActive;
}

export function canResume(st: any) {
  // ✅ можна продовжити рух і коли ми просто зупинились,
  // ✅ і коли на об’єкті вже йдуть роботи
  const okPhase =
    st.phase === "PAUSED_AT_OBJECT" || st.phase === "WORKING_AT_OBJECT";

  return okPhase && !st.driveActive && !st.returnActive;
}

export function canFinishDay(st: State) {
  // “останній об’єкт” — це умовно: коли бригадир вирішив, що далі тільки return.
  // Ти казав: “на останньому об’єкті кнопка стоп і появляється повернення на базу”.
  return st.phase === "PAUSED_AT_OBJECT" && !st.driveActive;
}

export function canStartReturn(st: State) {
  return st.phase === "WAIT_RETURN" && !st.returnActive;
}

export function canStopReturn(st: State) {
  return st.phase === "RETURN_DRIVE" && st.returnActive;
}

export function canEnterOdoEnd(st: State) {
  return st.phase === "FINISHED" && !st.returnActive;
}

export function canSave(st: State) {
  return (
    !!st.carId &&
    st.odoStartKm !== undefined &&
    st.odoEndKm !== undefined &&
    st.phase === "FINISHED"
  );
}