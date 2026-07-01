// src/bot/core/cb.ts
export const CB = {
  MENU: "common:menu",
  START_MENU: "start_menu",
  OPEN_FLOW: "common:open:", 
  ROAD_STATS: "common:road_stats",
  
} as const;


export type CommonCb = (typeof CB)[keyof typeof CB];
