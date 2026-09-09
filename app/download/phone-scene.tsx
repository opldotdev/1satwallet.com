"use client";

import { useGLTF, useTexture } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, SMAA } from "@react-three/postprocessing";
import { Suspense, useEffect, useMemo, useRef } from "react";
import {
	Box3,
	Mesh,
	type MeshStandardMaterial,
	NeutralToneMapping,
	PMREMGenerator,
	ShaderChunk,
	SRGBColorSpace,
	Vector3,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const finishes = new Set([
	"Titanium.001",
	"Titanium Button",
	"Backside Neutral",
	"Backside Apple Logo.001",
	"Material.006",
	"specialmetal",
]);

export function Studio() {
	const { gl, scene, invalidate } = useThree();
	useEffect(() => {
		const generator = new PMREMGenerator(gl);
		const room = new RoomEnvironment();
		const environment = generator.fromScene(room, 0.04);
		scene.environment = environment.texture;
		scene.environmentIntensity = 0.8;
		invalidate();
		return () => {
			scene.environment = null;
			environment.dispose();
			room.dispose();
			generator.dispose();
		};
	}, [gl, scene, invalidate]);
	return null;
}

export function Phone({ onReady }: { onReady: () => void }) {
	const { scene } = useGLTF("/download/iphone17.glb", "/download/draco/");
	const screenshot = useTexture("/download/iphone-launch.png");
	const walletScreenshot = useTexture("/download/iphone-wallet-1220.png");
	const elapsed = useRef(0);
	const reducedMotion = useRef(false);
	const invalidate = useThree((state) => state.invalidate);
	// Adapted from frenly.chat's phone-scene: preserve the authored display UVs.
	const phone = useMemo(() => {
		const root = scene.clone(true);
		const texture = screenshot.clone();
		const walletTexture = walletScreenshot.clone();
		walletTexture.flipY = false;
		walletTexture.colorSpace = SRGBColorSpace;
		walletTexture.anisotropy = 8;
		walletTexture.needsUpdate = true;
		const blend = { value: 0 };
		const materials: MeshStandardMaterial[] = [];
		root.traverse((child) => {
			if (!(child instanceof Mesh) || Array.isArray(child.material)) return;
			const source = child.material as MeshStandardMaterial;
			const name = source.name.trim();
			if (name === "Led Screen Glass") {
				child.visible = false;
				return;
			}
			const material = source.clone();
			materials.push(material);
			child.material = material;
			// The untextured light-blocking plane is visible through the island cutout.
			if (child.name === "Light-Blocking_Plane" || !name) {
				material.color.set(0x000000);
				material.metalness = 0;
				material.roughness = 1;
			}
			if (finishes.has(name)) {
				material.color.set("#161619");
				material.roughness = Math.max(material.roughness, 0.38);
			}
			if (
				[
					"Black Glass",
					"Black Glass.001",
					"Material.002",
					"Material.005",
				].includes(name)
			) {
				material.color.set("#08080a");
				material.metalness = 0;
				material.roughness = 0.12;
			}
			if (name === "Material.004") {
				material.color.set("#e6e2dc");
				material.metalness = 0;
				material.roughness = 0.35;
			}
			if (name !== "LED DISPLAY" || !source.emissiveMap) return;
			const original = source.emissiveMap;
			texture.flipY = false;
			texture.colorSpace = SRGBColorSpace;
			texture.anisotropy = 8;
			texture.channel = original.channel;
			texture.offset.copy(original.offset);
			texture.repeat.copy(original.repeat);
			texture.rotation = original.rotation;
			texture.center.copy(original.center);
			texture.needsUpdate = true;
			material.map = null;
			material.color.set(0);
			material.emissive.set(0xffffff);
			material.emissiveMap = texture;
			material.emissiveIntensity = 1;
			material.toneMapped = false;
			material.onBeforeCompile = (shader) => {
				shader.uniforms.walletScreen = { value: walletTexture };
				shader.uniforms.screenBlend = blend;
				shader.fragmentShader =
					`uniform sampler2D walletScreen; uniform float screenBlend;\n${shader.fragmentShader}`.replace(
						"#include <emissivemap_fragment>",
						ShaderChunk.emissivemap_fragment.replace(
							"texture2D( emissiveMap, vEmissiveMapUv )",
							"mix(texture2D(emissiveMap, vEmissiveMapUv), texture2D(walletScreen, vEmissiveMapUv), screenBlend)",
						),
					);
			};
			material.customProgramCacheKey = () => "phone-launch-crossfade-v1";
		});
		const box = new Box3().setFromObject(root);
		const scale = 1.9 / box.getSize(new Vector3()).y;
		const center = box.getCenter(new Vector3()).multiplyScalar(-scale);
		return { root, scale, center, materials, texture, walletTexture, blend };
	}, [scene, screenshot, walletScreenshot]);
	useEffect(() => {
		reducedMotion.current = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		elapsed.current = 0;
		phone.blend.value = 0;
	}, [phone]);
	useFrame((_, delta) => {
		if (phone.blend.value === 1) return;
		elapsed.current += delta;
		const progress = Math.min(1, Math.max(0, (elapsed.current - 1.6) / 0.6));
		phone.blend.value = reducedMotion.current
			? elapsed.current >= 1.6
				? 1
				: 0
			: progress * progress * (3 - 2 * progress);
		invalidate();
	});
	useEffect(() => {
		invalidate();
		onReady();
	}, [invalidate, onReady]);
	useEffect(
		() => () => {
			for (const material of phone.materials) material.dispose();
			phone.texture.dispose();
			phone.walletTexture.dispose();
		},
		[phone],
	);
	return (
		<group rotation={[-0.06, -0.18, -0.065]}>
			<primitive
				object={phone.root}
				scale={phone.scale}
				position={phone.center}
			/>
		</group>
	);
}

export default function PhoneScene({ onReady }: { onReady: () => void }) {
	return (
		<Canvas
			camera={{ fov: 30, position: [0, 0, 4.1] }}
			dpr={2}
			frameloop="demand"
			gl={{ alpha: true, antialias: true, toneMapping: NeutralToneMapping }}
		>
			<Studio />
			<directionalLight intensity={1.3} position={[3, 4, 5]} />
			<directionalLight intensity={0.5} position={[-4, 1, 3]} />
			<Suspense fallback={null}>
				<Phone onReady={onReady} />
			</Suspense>
			<EffectComposer multisampling={4}>
				<SMAA />
			</EffectComposer>
		</Canvas>
	);
}
