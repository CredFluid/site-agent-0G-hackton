declare module "@sparticuz/chromium" {
  export const args: string[];
  export let setGraphicsMode: boolean | undefined;
  export function executablePath(location?: string): Promise<string>;

  const chromium: {
    args: string[];
    setGraphicsMode?: boolean;
    executablePath(location?: string): Promise<string>;
  };

  export default chromium;
}
