import React, { useState, useEffect } from 'react';
// @ts-ignore - ESM module
import { Text, Box, useInput, useApp } from 'ink';
// @ts-ignore - ESM module
import Spinner from 'ink-spinner';
// @ts-ignore - ESM module
import SelectInput from 'ink-select-input';
import gradient from 'gradient-string';
import { LampAnimation } from '../animations/LampAnimation';
import { PortalAnimation } from '../animations/PortalAnimation';
import { ScrollAnimation } from '../animations/ScrollAnimation';
import { ConstellationAnimation } from '../animations/ConstellationAnimation';

const genieGradient = gradient(['#FF6B9D', '#C06FEF', '#4D8FFF']);
const successGradient = gradient(['#00F260', '#0575E6']);
const warningGradient = gradient(['#FFA500', '#FF6B9D']);

interface IntelligentEntryProps {
  currentVersion: string;
  latestVersion: string;
  isWorkspaceInitialized: boolean;
  hasOldVersion: boolean;
  onUpdate: () => void;
  onInit: () => void;
  onUpgrade: () => void;
  onStart: () => void;
}

type DetectionState = 'animation' | 'checking-update' | 'needs-update' | 'checking-workspace' | 'needs-init' | 'needs-upgrade' | 'ready' | 'starting';

const ANIMATIONS = [LampAnimation, PortalAnimation, ScrollAnimation, ConstellationAnimation];

// Streaming text component
const StreamingText: React.FC<{ text: string; onComplete: () => void; delay?: number }> = ({ text, onComplete, delay = 30 }) => {
  const [displayedText, setDisplayedText] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (currentIndex < text.length) {
      const timeout = setTimeout(() => {
        setDisplayedText(text.slice(0, currentIndex + 1));
        setCurrentIndex(currentIndex + 1);
      }, delay);
      return () => clearTimeout(timeout);
    } else if (currentIndex === text.length && text.length > 0) {
      const timeout = setTimeout(() => {
        onComplete();
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [currentIndex, text, delay, onComplete]);

  return <Text>{displayedText}</Text>;
};

export const IntelligentEntry: React.FC<IntelligentEntryProps> = ({
  currentVersion,
  latestVersion,
  isWorkspaceInitialized,
  hasOldVersion,
  onUpdate,
  onInit,
  onUpgrade,
  onStart,
}) => {
  const { exit } = useApp();
  const [state, setState] = useState<DetectionState>('animation');
  const [streamComplete, setStreamComplete] = useState(false);
  const [selectedAction, setSelectedAction] = useState<string | null>(null);

  // Random animation selection
  const [AnimationComponent] = useState(() => {
    const randomIndex = Math.floor(Math.random() * ANIMATIONS.length);
    return ANIMATIONS[randomIndex];
  });

  const needsUpdate = currentVersion !== latestVersion;

  // Handle animation complete
  const handleAnimationComplete = () => {
    setState('checking-update');
    setStreamComplete(false);
  };

  // Handle streaming text complete
  const handleStreamComplete = () => {
    setStreamComplete(true);
  };

  // Auto-progress logic
  useEffect(() => {
    if (!streamComplete) return;

    if (state === 'checking-update') {
      if (needsUpdate) {
        setState('needs-update');
        setStreamComplete(false);
      } else {
        setTimeout(() => {
          setState('checking-workspace');
          setStreamComplete(false);
        }, 800);
      }
    } else if (state === 'checking-workspace') {
      if (hasOldVersion) {
        setState('needs-upgrade');
        setStreamComplete(false);
      } else if (!isWorkspaceInitialized) {
        setState('needs-init');
        setStreamComplete(false);
      } else {
        setState('ready');
        setStreamComplete(false);
      }
    }
  }, [streamComplete, state, needsUpdate, isWorkspaceInitialized, hasOldVersion]);

  // Handle user input for confirmations
  useInput((input, key) => {
    if (state === 'ready' && streamComplete) {
      if (key.return) {
        setState('starting');
        setTimeout(() => {
          onStart();
          exit();
        }, 1000);
      }
    }
  });

  // Handle menu selections
  const handleSelect = (item: { value: string }) => {
    setSelectedAction(item.value);

    if (state === 'needs-update') {
      if (item.value === 'yes') {
        onUpdate();
        exit();
      } else {
        setState('checking-workspace');
        setStreamComplete(false);
        setSelectedAction(null);
      }
    } else if (state === 'needs-init') {
      if (item.value === 'yes') {
        onInit();
        exit();
      } else {
        exit();
      }
    } else if (state === 'needs-upgrade') {
      if (item.value === 'yes') {
        onUpgrade();
        exit();
      } else {
        exit();
      }
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      {state === 'animation' && <AnimationComponent onComplete={handleAnimationComplete} />}

      {state === 'checking-update' && (
        <Box flexDirection="column">
          <Text>{genieGradient('━'.repeat(60))}</Text>
          <Box marginY={1}>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text> </Text>
            <StreamingText
              text="Hey there! I'm Genie. Let me check if I'm running the latest version..."
              onComplete={handleStreamComplete}
            />
          </Box>
        </Box>
      )}

      {state === 'needs-update' && !selectedAction && (
        <Box flexDirection="column">
          <Text>{genieGradient('━'.repeat(60))}</Text>
          <Box marginY={1} flexDirection="column">
            <StreamingText
              text={`Looks like I found a newer version! You're on v${currentVersion}, but v${latestVersion} is available.`}
              onComplete={handleStreamComplete}
            />
          </Box>
          {streamComplete && (
            <Box marginY={1}>
              <Text>{warningGradient('Would you like me to update now?')}</Text>
            </Box>
          )}
          {streamComplete && (
            <SelectInput
              items={[
                { label: 'Yes, update now', value: 'yes' },
                { label: 'No, skip for now', value: 'no' },
              ]}
              onSelect={handleSelect}
            />
          )}
        </Box>
      )}

      {state === 'checking-workspace' && (
        <Box flexDirection="column">
          <Text>{genieGradient('━'.repeat(60))}</Text>
          <Box marginY={1}>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text> </Text>
            <StreamingText
              text="Great! Now let me check if your workspace is initialized..."
              onComplete={handleStreamComplete}
            />
          </Box>
        </Box>
      )}

      {state === 'needs-init' && !selectedAction && (
        <Box flexDirection="column">
          <Text>{genieGradient('━'.repeat(60))}</Text>
          <Box marginY={1} flexDirection="column">
            <StreamingText
              text="I can see you don't have a .genie workspace initialized yet. Would you like me to set one up for you?"
              onComplete={handleStreamComplete}
            />
          </Box>
          {streamComplete && (
            <Box marginY={1}>
              <Text>{warningGradient('Initialize workspace now?')}</Text>
            </Box>
          )}
          {streamComplete && (
            <SelectInput
              items={[
                { label: 'Yes, initialize workspace', value: 'yes' },
                { label: 'No, exit for now', value: 'no' },
              ]}
              onSelect={handleSelect}
            />
          )}
        </Box>
      )}

      {state === 'needs-upgrade' && !selectedAction && (
        <Box flexDirection="column">
          <Text>{genieGradient('━'.repeat(60))}</Text>
          <Box marginY={1} flexDirection="column">
            <StreamingText
              text={`I see you have an old Genie workspace here. Don't worry! Your data is safe. I'm going to learn from it and preserve everything. I'll create a backup at .genie.backup just in case. Ready to upgrade?`}
              onComplete={handleStreamComplete}
            />
          </Box>
          {streamComplete && (
            <Box marginY={1}>
              <Text>{warningGradient('Upgrade workspace now?')}</Text>
            </Box>
          )}
          {streamComplete && (
            <SelectInput
              items={[
                { label: 'Yes, upgrade my workspace', value: 'yes' },
                { label: 'No, exit for now', value: 'no' },
              ]}
              onSelect={handleSelect}
            />
          )}
        </Box>
      )}

      {state === 'ready' && (
        <Box flexDirection="column">
          <Text>{genieGradient('━'.repeat(60))}</Text>
          <Box marginY={1} flexDirection="column">
            <StreamingText
              text={`Perfect! You're all set with v${currentVersion} and your workspace is ready to go. Let's get started! ✨`}
              onComplete={handleStreamComplete}
            />
          </Box>
          {streamComplete && (
            <Box marginY={1}>
              <Text>{successGradient('Press ENTER to start Genie...')}</Text>
            </Box>
          )}
        </Box>
      )}

      {state === 'starting' && (
        <Box flexDirection="column">
          <Text>{genieGradient('━'.repeat(60))}</Text>
          <Box marginY={1}>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text> {successGradient('Starting Genie...')}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
