declare module "node-webpmux" {
  export type WebPFrame = {
    delay?: number;
    x?: number;
    y?: number;
    blend?: boolean;
    dispose?: boolean;
  };

  export class Image {
    static generateFrame(options: {
      path?: string;
      buffer?: Buffer;
      img?: Image;
      x?: number;
      y?: number;
      delay?: number;
      blend?: boolean;
      dispose?: boolean;
    }): Promise<WebPFrame>;

    static save(
      path: string | null,
      options: {
        width: number;
        height: number;
        frames: WebPFrame[];
        bgColor?: [number, number, number, number];
        loops?: number;
        delay?: number;
        x?: number;
        y?: number;
        blend?: boolean;
        dispose?: boolean;
      }
    ): Promise<Buffer | void>;
  }

  const WebP: {
    Image: typeof Image;
  };

  export default WebP;
}
