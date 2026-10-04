import { defaultRehypePlugins, type StreamdownProps } from "streamdown";

// A Chat reply shows no picture. Every img and source node is deleted before
// the page sees it, so opening a chat cannot ask another website for a file.
//
// rehype-harden alone is not enough. It still allows blob: pictures even when
// its image list is empty, and it never looks at a <source srcset> address.
// The page rule in frontend/index.html stays as a second layer.

interface PictureNode {
  children?: PictureNode[];
  tagName?: string;
  type?: string;
}

const pictureTags = new Set(["img", "source"]);

function dropPictures(node: PictureNode): void {
  const { children } = node;
  if (!children) {
    return;
  }
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child.type === "element" && pictureTags.has(child.tagName ?? "")) {
      children.splice(index, 1);
    } else {
      dropPictures(child);
    }
  }
}

type ReplyRehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;

const removeReplyPictures: ReplyRehypePlugins[number] =
  () => (tree: unknown) => {
    dropPictures(tree as PictureNode);
  };

export const replyRehypePlugins: ReplyRehypePlugins = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
  removeReplyPictures,
];
