import { useState } from 'react';

export function useStitch() {
  const [isGenerating, setIsGenerating] = useState(false);

  const generateUI = async (prompt: string) => {
    setIsGenerating(true);
    // In a real implementation, this would call a backend endpoint that uses Stitch API
    console.log('Generating UI for:', prompt);
    setIsGenerating(false);
    return { success: true };
  };

  return { generateUI, isGenerating };
}
