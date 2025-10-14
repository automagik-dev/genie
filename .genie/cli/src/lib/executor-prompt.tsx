export async function promptExecutorChoice(
  availableExecutors: string[],
  defaultExecutor: string
): Promise<string> {
  const React = await import('react');
  const { render } = await import('ink');
  const { Box, Text, useInput, useApp } = await import('ink');

  interface ExecutorSelectorProps {
    executors: string[];
    defaultExecutor: string;
    onSelect: (executor: string) => void;
  }

  const ExecutorSelector: React.FC<ExecutorSelectorProps> = ({ executors, defaultExecutor, onSelect }) => {
    const [selectedIndex, setSelectedIndex] = React.useState(
      executors.indexOf(defaultExecutor) >= 0 ? executors.indexOf(defaultExecutor) : 0
    );
    const { exit } = useApp();

    useInput((input: string, key: any) => {
      if (key.upArrow || input === 'k') {
        setSelectedIndex((prev: number) => (prev > 0 ? prev - 1 : executors.length - 1));
      }

      if (key.downArrow || input === 'j') {
        setSelectedIndex((prev: number) => (prev < executors.length - 1 ? prev + 1 : 0));
      }

      if (key.return) {
        onSelect(executors[selectedIndex]);
        exit();
      }

      if (key.escape || (key.ctrl && input === 'c')) {
        onSelect(defaultExecutor);
        exit();
      }
    });

    return React.createElement(
      Box,
      { flexDirection: 'column', paddingY: 1 },
      React.createElement(
        Box,
        { marginBottom: 1 },
        React.createElement(Text, { bold: true }, 'Select executor:')
      ),
      ...executors.map((executor, index) => {
        const isSelected = index === selectedIndex;
        const isDefault = executor === defaultExecutor;

        return React.createElement(
          Box,
          { key: executor, marginLeft: 2 },
          React.createElement(
            Text,
            { color: isSelected ? 'cyan' : 'white' },
            isSelected ? '❯ ' : '  ',
            React.createElement(Text, { bold: isSelected }, executor),
            isDefault && React.createElement(Text, { dimColor: true }, ' (default)')
          )
        );
      }),
      React.createElement(
        Box,
        { marginTop: 1, marginLeft: 2 },
        React.createElement(Text, { dimColor: true }, '↑↓: Navigate • Enter: Select • Esc: Use default')
      )
    );
  };

  return new Promise((resolve) => {
    const { unmount } = render(
      React.createElement(ExecutorSelector, {
        executors: availableExecutors,
        defaultExecutor,
        onSelect: (selected: string) => {
          unmount();
          resolve(selected);
        }
      })
    );
  });
}
