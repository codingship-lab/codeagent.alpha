'use client';

import { useState } from 'react';

export function useStitch() {
  const [isGenerating, setIsGenerating] = useState(false);

  const generateUI = async (prompt) => {
    setIsGenerating(true);
    console.log('Generating UI for:', prompt);
    setIsGenerating(false);
    return { success: true };
  };

  return { generateUI, isGenerating };
}
