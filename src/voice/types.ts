// A single section of a curated plan — "here's one thing worth saying."
// keyInsight is spoken English; highlightText is a verbatim copy from source for
// attribution in the quote card UI.
export interface CuratedSection {
  title: string;          // 2–5 word topical label for the outline pill ("Sidecar proxies")
  notePath?: string;      // optional — section may be conceptual, not tied to a note
  heading?: string;       // optional — for scrolling to a heading on the page
  highlightText?: string; // verbatim phrase from the note for DOM highlight
  keyInsight: string;     // one-sentence spoken-English insight ("the aha")
}

// Output of the planner — a tight plan of what's worth saying. Chat agent voices
// preamble, then sections one at a time, optionally ending with followUp.
export interface CuratedPlan {
  preamble: string;
  sections: CuratedSection[];
  followUp?: string;
}

// Session-level context passed into the planner so it can focus on the user's
// current reading (open note / highlighted passage) instead of the whole vault.
export interface VoiceSessionContext {
  notePath?: string;
  noteContent?: string;
  highlightedText?: string;
  notesTree?: string;
}
