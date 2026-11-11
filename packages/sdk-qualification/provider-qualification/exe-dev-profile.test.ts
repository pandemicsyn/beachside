import { expect, test } from "bun:test";
import profile from "./exe-dev-profile";
import { profileRouting } from "./profile";

test("exe.dev profile keeps internet routing and declares what exe.dev cannot do, without IO", () => {
  const routing = profileRouting(profile, {});

  expect(routing).toEqual({
    imageId: "exeuntu",
    networkPolicy: "internet",
    nativeLifetimeSeconds: 900,
  });
  expect(profileRouting(profile, { BEACHSIDE_EXE_DEV_IMAGE: "ubuntu:24.04" }).imageId).toBe(
    "ubuntu:24.04",
  );
  expect(profileRouting(profile, {}, routing)).toEqual(routing);
  expect(profile.credentialVariables).toEqual(["EXE_API_KEY"]);
  expect(profile.configuration(routing)).toMatchObject({ imageClass: "oci", fileRoot: "/tmp" });

  for (const feature of [
    "execution",
    "streaming",
    "termination",
    "suspension",
    "reopening",
  ] as const)
    expect(profile.support.features[feature].support).toBe("conditional");

  for (const feature of ["renewal", "snapshots", "network", "volumes", "oci"] as const)
    expect(profile.support.features[feature].support).toBe("unsupported");
  expect(() => profileRouting(profile, {}, { ...routing, networkPolicy: "blocked" })).toThrow();
});
