export type Theme = {
  theme: string;
  sectors: string[];
  keywords: string[];
  drivers?: string[];
  rationale?: string;
  strength?: number;
  marketScore?: number;
  narrativeScore?: number;
  overlapBoost?: number;
  sourceEvidenceCount?: number;
};

