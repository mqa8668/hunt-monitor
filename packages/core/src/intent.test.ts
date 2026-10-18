import { describe, expect, test } from "bun:test";
import { detectIntent } from "./intent";

describe("detectIntent (en)", () => {
  test("sell cues", () => {
    expect(detectIntent("iphone 15 pro for sale, 256gb").intent).toBe("sell");
    expect(detectIntent("wts fujifilm x100v obo").intent).toBe("sell");
  });
  test("buy cues", () => {
    expect(detectIntent("wtb road bike size 54").intent).toBe("buy");
    expect(detectIntent("looking for a used macbook air").intent).toBe("buy");
  });
  test("earliest cue wins", () => {
    expect(detectIntent("for sale: bike, anyone looking for a deal message me").intent).toBe("sell");
    expect(detectIntent("wanted: camera, will pay cash, not for sale").intent).toBe("buy");
  });
  test("no cue is other", () => {
    expect(detectIntent("hello world").intent).toBe("other");
  });
  test("vietnamese words are ignored without the pack", () => {
    expect(detectIntent("cần bán kia morning").intent).toBe("other");
  });
});

describe("detectIntent (vi pack)", () => {
  test("earliest cue wins; a seller addressing buyers is a sale", () => {
    expect(detectIntent("cần bán kia morning, ai cần mua ib", "vi").intent).toBe("sell");
    expect(detectIntent("ban xe, ai co nhu cau lien he", "vi").intent).toBe("sell");
  });
  test("buy cues", () => {
    expect(detectIntent("cần mua vios 2016", "vi").intent).toBe("buy");
    expect(detectIntent("thu mua xe cũ giá cao", "vi").intent).toBe("buy");
    expect(detectIntent("cần mua xe, ai bán ib", "vi").intent).toBe("buy");
  });
  test("bare mua is a weak buy", () => {
    expect(detectIntent("mua iphone", "vi").confidence).toBe(0.55);
  });
});
