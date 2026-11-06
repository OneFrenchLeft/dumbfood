export type Unit = "g" | "L" | "portion" | "place" | "piece";
export type Category = "ingredient" | "equipment";
export interface MealEvent {
  id: string;
  title: string;
  date: string;
  location: string;
  address: string;
  description: string;
  shareToken: string;
  archived: boolean;
  version: number;
}
export interface Participant {
  id: string;
  eventId: string;
  name: string;
}
export interface Item {
  id: string;
  eventId: string;
  name: string;
  category: Category;
  unit: Unit;
  target: number | null;
  version: number;
}
export interface Contribution {
  id: string;
  itemId: string;
  participantId: string;
  quantity: number;
  capacity: number | null;
  note: string;
  version: number;
}
export interface Activity {
  id: string;
  actor: string;
  description: string;
  createdAt: string;
}
export interface EventSnapshot {
  event: MealEvent;
  participants: Participant[];
  items: Item[];
  contributions: Contribution[];
  activity: Activity[];
}
export interface Session {
  admin: boolean;
  actor: string | null;
}
