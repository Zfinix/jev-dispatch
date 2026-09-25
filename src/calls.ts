// One shape for every city. `headline` and `detail` are what the calltaker
// knew and what Jev sees; `truth` holds the dispatcher's answers by aspect key.
export type CityId = "detroit" | "sf";

export type Call = {
  city: CityId;
  id: string;
  at: number;
  headline: string;
  detail: string;
  neighborhood: string;
  area: string;
  lat: number;
  lng: number;
  truth: Record<string, string | null>;
  facts: Record<string, string>;
};

export const bucket = (minutes: number | null) => (minutes === null || minutes < 0 ? null : minutes < 5 ? "0" : minutes < 15 ? "1" : minutes < 30 ? "2" : minutes < 60 ? "3" : "4");
