export type Unit = string;

export type Dictionaries = {
  objects: { id: string; name: string; active: boolean }[];
  brigades: { id: string; name: string; active: boolean }[];
  employees: { id: string; name: string; brigadeId: string; active: boolean }[];
  workTypes: { id: string; name: string; unit: Unit; tariff: number; active: boolean }[];
};

export type DraftRecord = {
  objectId?: string;
  brigadeId?: string;
  workTypeId?: string;

  volumeValue?: number;
  volumeUnit?: Unit;

  employeeIds?: string[];
  hours?: number;
  coef?: number;

  photoFileId?: string;
};

export type FinalRecord = {
  recordId: string;
  datetime: string;

  objectId: string;
  objectName: string;

  brigadeId: string;
  brigadeName: string;

  workTypeId: string;
  workTypeName: string;

  volumeValue: number;
  volumeUnit: Unit;

  employeeIds: string;     
  employeeNames: string;   

  workedHours: number;
  coef: number;

  tariff: number;
  sum: number;

  status: "Новий" | "Виконаний" | "Потрібна правка";

  foremanTgId: number;
  foremanUsername: string;

  photoUrl?: string;
  commentAdmin?: string;
};
